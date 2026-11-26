## Why

Now and then, when Tabby starts and restores several tomux tabs, one tab shows `tomux needs tmux 2.1 or newer, but the host has no usable tmux (tmux -V failed: no output; stderr: ""; EOF: no; channel closed after 89 ms)`. Pressing Reconnect on that tab always fixes it. On a macOS host it happened in about 2 of 13 startups recorded in Tabby's log, and it also happened before the current branches.

What was observed:

- The failing tab was the first to connect. It ran `tmux -V` on a freshly logged-in SSH session, and the channel closed with no output, no stderr and no EOF. tomux then released the session, and Tabby destroyed it. The other tabs connected a few seconds later on a new SSH session and worked.
- The host's sshd log shows that session logging in normally and no error afterwards.
- With OpenSSH as the client, 120 `tmux -V` runs on that host all answered, 40 in a row and 80 in parallel bursts. Over an open connection the command takes 15–28 ms, so 89 ms is long enough for it to have finished normally.

The cause is not confirmed. The evidence points to the output and EOF being lost in Tabby's SSH client, not to a failure on the host. Since a second attempt works, tomux should make it.

## What Changes

- When `tmux -V` closes with no output, tomux runs it once more on a new channel of the same SSH session. It logs a warning with the first attempt's details. If the second attempt succeeds, the tab connects as normal.
- No retry when there is nothing to gain: when the SSH session was destroyed during the check, when `tmux -V` timed out or the exec request was refused, when the output is not from tmux, or when tmux is too old. Those cases fail as today.
- If the second attempt also fails, the tab shows the error as today, with the second attempt's details.
- The "no output" error also says whether the SSH session was destroyed while the check ran (`SSH session destroyed: yes|no`). That separates a session lost under the check from a channel that closed on its own.
- Each tomux tab logs which SSH session its tmux connection used (numbered per Tabby run), the tab's intent (`new`, `adopt @<id>`, `reopen @<id>`), and whether it opened the connection, shared one already open, or failed (with the error).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-control-connection`: two requirements are added next to "Minimum tmux version". One retries an empty `tmux -V` reply once. The other has the error for an empty reply name its diagnostics, including whether the SSH session was destroyed.

## Impact

- Code: `src/sshTransport.ts` (records whether the session was destroyed, numbers SSH sessions, reports an empty reply as its own error type), `src/tmux/transport.ts` (that error type), `src/tmux/connection.ts` (`checkTmuxVersion` retries once and warns through a new `warn` option on `TomuxConnection.open`), `src/binding.ts` (`describeIntent`, for the log), `src/components/tomuxTab.component.ts` (passes the warning to the tab's log and logs the connection line). `src/tmux/fakeTmux.testing.ts` gets scripted version replies.
- Tests: `src/sshTransport.spec.ts`, `src/tmux/connection.spec.ts`, `src/binding.spec.ts`.
- No API, dependency or configuration changes. A tab connecting normally behaves as before; the retry adds one round trip only after an empty reply.
- Risk: if the reply is empty for a reason a retry cannot fix, the tab takes one extra round trip (under 100 ms here) before showing the error. The warning stays in the log, so the retry does not hide the problem.
- `doc/TESTING.md` gets the result of the check in a running Tabby.
