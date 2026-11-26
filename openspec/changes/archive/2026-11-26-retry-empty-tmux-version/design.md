## Context

`TomuxConnection.open` (`src/tmux/connection.ts`) runs `checkTmuxVersion` before it opens the control channel. That calls `ControlTransport.readTmuxVersion`. In `SshControlTransport` (`src/sshTransport.ts`), it opens a new exec channel on Tabby's SSH session, runs `tmux -V 2>&1`, collects stdout until the channel closes, and closes the channel. Empty output becomes a plain `Error` with the stderr text, EOF state and channel lifetime. `checkTmuxVersion` wraps every failure in `TmuxVersionError("no usable tmux (tmux -V failed: …)")`, and the tab shows it.

The first tab to connect opens the shared tmux connection (`ConnectionRegistry.acquire`). If its check fails, `open` releases the SSH session. When no other holder remains, Tabby destroys the session (`SSHSession.unref` → `destroy`). Other tabs that join the same pending `acquire` get the same error.

See the proposal for what was observed. The cause is unknown, but a second attempt has always worked.

This branch already has diagnostics written before the change:

- `readTmuxVersion` records whether `willDestroy$` fired while the check ran, and the error ends with `SSH session destroyed: yes|no`.
- `sshSessionNumber(session)` gives each SSH session object a number for the log.
- `describeIntent(intent)` formats a tab's bind intent for the log.
- `TomuxTabComponent.connect` logs one line per connect (see D5 for the wording).

## Goals / Non-Goals

**Goals:**

- A tab whose first `tmux -V` comes back empty connects anyway when a second attempt answers.
- Each retry leaves a warning in the log with the first attempt's details, so the problem stays visible.
- Keep the diagnostics above.

**Non-Goals:**

- Finding the root cause in Tabby's SSH client (russh). It is native code bundled with Tabby; tomux cannot change it.
- Retrying the whole connection, or retrying more than once.
- Changing how other tabs join a failed `acquire`. With the retry, the opener's attempt usually succeeds, so they join a working connection.

## Decisions

### D1. The transport reports an empty reply as its own error type

A new `TmuxVersionNoOutputError` in `src/tmux/transport.ts` carries the diagnostic message and a `sessionDestroyed` flag. `SshControlTransport.readTmuxVersion` throws it instead of a plain `Error`, and the message text stays as it is.

*Why:* `checkTmuxVersion` has to tell "empty reply, session alive" from the cases that must not be retried, and parsing the message would be fragile. The type lives next to the `ControlTransport` interface, so `FakeTmux` can throw it too.

*Alternative:* `readTmuxVersion` could return `''` and leave the rest to `checkTmuxVersion`. Rejected: the diagnostics (stderr, EOF, lifetime) belong to the SSH layer and would be lost.

### D2. The retry lives in `checkTmuxVersion`, not in the SSH transport

`checkTmuxVersion` calls `readTmuxVersion` once more when the first call throws `TmuxVersionNoOutputError` with `sessionDestroyed` false. It first warns: `tmux -V gave no output, trying once more (<first message>)`. If the second call fails for any reason, that failure becomes the `TmuxVersionError` as today. If it succeeds, the output goes through the usual tmux check and version check.

*Why:* the retry policy is transport-independent and testable with `FakeTmux`. The transport stays a thin wrapper over one channel. `readTmuxVersion` already opens a new channel on every call, so a retry needs no new transport method.

*Alternative:* retry inside `SshControlTransport.readTmuxVersion`. Rejected: it hides the policy in the layer without unit-testable timing, and the transport has no logger.

### D3. Warnings go out through a `warn` option on `TomuxConnection.open`

`TomuxConnectionOptions` gains `warn?: (message: string) => void`. The tab passes a callback that logs the message as a warning with the session and tab appended: `tmux -V gave no output, trying once more (<diagnostics>) (SSH session #N, tab <intent>)`. Without it (tests, other callers) the warning is dropped.

*Why:* `connection.ts` has no logger, and adding Tabby's `LogService` there would tie the tmux layer to Tabby. A callback follows the pattern the tab already uses (`warnLater`, `repairSftpPanelAccessor`).

### D4. No delay before the retry

The retry runs straight away.

*Why:* the failure showed up as a lost reply on a working session, and the second attempt (Reconnect) worked without waiting. A delay would slow down the very case the retry is for. If logs later show quick retries also failing, a short delay can be added then.

### D4b. The time limit covers opening the channel

`SshControlTransport.readTmuxVersion` starts its 10 s deadline before it opens the channel, and races the channel open, the exec request and the reply against it. A channel that opens after the deadline is closed as soon as it arrives. Before, the deadline only started once the channel was open, so a channel-open request that never answered hung the check and every tab waiting on that connection. The retry opens a second channel at the moment the session looks least healthy, so this hole matters more now. (Second code review.)

### D4c. A failed retry reports both attempts

When the second attempt fails, the error names its diagnostics followed by the first attempt's: `<second> (first attempt: <first>)`. The session can be destroyed between the attempts, and then the second error ("The SSH connection is not logged in") says less than the first. The tab should still show the first attempt's lost-reply details, not only the log. (Second code review.)

### D5. Diagnostics stay in, with no spec for the tab's log line

The `SSH session destroyed` part of the error is specified (it is user-visible in the tab). The per-tab connection log line is a developer aid. It is built from two tested pure helpers (`sshSessionNumber`, `describeIntent`) and is not specified, so its wording can change without a spec change.

The line's wording comes from one pure function, `connectionLogLine` in `src/connectionLog.ts`, so it is unit-tested without building the tab component:

- `tmux connection opened on SSH session #N (tab <intent>)`
- `tmux connection shared, on SSH session #M (tab <intent>)`
- `tmux connection failed on SSH session #N (tab <intent>): <error>`: this tab opened the attempt
- `tmux connection failed in another tab's attempt (tab <intent>): <error>`: this tab joined it

The session number in that line is the one tmux runs on. Tabs that each set up their own SSH session still share one tmux connection, opened on the first tab's session. So the opener passes its label (`SSH session #N`) to `TomuxConnection.open` as `sessionLabel`, and tabs that share log the connection's label. A tab that joined a failed attempt has no connection to read it from, so it logs that it joined another tab's attempt. Only the opener names the session that failed. (Code review finding.)

`SSH session destroyed` is watched from before the channel opens, and Tabby's `willDestroy` subject completing counts as destroyed. `SSHSession.destroy()` calls `next()` and then `complete()`, so a subscriber added after a destroy only gets `complete`. (Code review finding.)

## Risks / Trade-offs

- [A retry hides a real, repeatable problem] → each retry logs a warning with the full first-attempt diagnostics, and a second failure still shows the error.
- [The retry runs on a session that is about to drop] → it adds one round trip (well under the 10 s timeout) before the same error. When `willDestroy$` already fired, there is no retry.
- [The lost reply comes from a Tabby SSH client bug that hits other channels too] → out of scope. The control channel's own failures are handled by the existing lost-connection path and Reconnect.

## Migration Plan

None. The plugin update takes effect on the next Tabby restart.

## Open Questions

- Does the second attempt actually succeed when the first comes back empty? The warning in the log answers this once the failure happens again in a running Tabby.
