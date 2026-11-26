# Design

## Context

See proposal.md for the two causes and how each was found.

How tabby-trzsz attaches: its `TerminalDecorator` puts a `SessionMiddleware` at the front of `terminal.session.middleware` for every terminal tab, tomux tabs included, and re-attaches on `sessionChanged$`. In Tabby's `BaseSession`:
- `feedFromTerminal(data)` → middleware → `outputToSession$` → `write(data)`. tomux does not override `feedFromTerminal`, so trzsz already sees and injects input.
- `emitOutput(data)` → middleware → `outputToTerminal$` → `output.next()` / `binaryOutput.next()`, or into `initialDataBuffer` until `releaseInitialDataBuffer()` is called.

In tomux:
- `TomuxPaneSession.write` decodes input as UTF-8, drops DSR/DA replies and calls `encodeSendKeys`. Step 3 of the encoder sends a bare `\n` as `send-keys -t <pane> Enter`. Every other control character goes out as `C-<letter>`.
- `OutputGate` orders a pane's output around the snapshot: `open(snapshot)` emits the snapshot, then the held live output, through one `emit` callback, which is `emitText` → `emitOutput`. The snapshot strings are built in `paneSession.ts`: the adopted capture (optionally after `CLEAR_SCREEN`), and on a pane switch `paneSwitchMarker + CLEAR_SCREEN + capture`.
- `tomuxTab.component.ts` calls `setSession(session)` (which subscribes the frontend to the session's output) before `await session.start(...)`, and `session.releaseInitialDataBuffer()` right after it. So the adopted snapshot is emitted while the initial buffer is still unreleased.

What trzsz does under tmux control mode (read in trzsz-go): `tsz`/`trz` detect control mode with `tmux display-message -p '#{client_control_mode}'`, force base64 (no binary), and print the start line with an id ending in `00`. trzsz.js never treats an id ending in `00` as a repeat.

## Goals / Non-Goals

**Goals:**
- Every byte trzsz sends reaches the pane unchanged.
- Terminal plugins see only output the pane produced after the tab was set up, never a replay of history.
- No tomux code that knows about trzsz.

**Non-Goals:**
- Speeding up uploads (for example a different encoding for large input). Measure first.
- Binary (non-base64) transfers. trzsz turns them off under tmux itself.
- Changing how any other key or sequence is encoded.
- Replays done by other code paths in Tabby (none known).

## Decisions

### 1. Send a bare `\n` as `C-j` by removing the special case

Delete the "bare `\n` → Enter" branch in `encodeSendKeys`. `\n` then reaches the existing control-character branch and goes out as `send-keys -t <pane> C-j`, which tmux writes as `0a`. `\r` stays in `KEY_MAP` as `Enter`.

Alternatives considered:
- **Send all input as `send-keys -H <hex>`, as tabby-tmux does.** Byte-exact by construction, but it needs tmux 3.0 (tomux supports 2.1), drops the key-name translation tomux relies on (arrows, Home and End in application cursor mode), and makes base64 uploads about three times larger than the literal runs used today.
- **Map `\n` to the hex token `0x0a`.** Same bytes, but it adds a special case where removing one is enough.
- **Switch to a raw mode only while a transfer runs.** tomux would have to know about trzsz, and it has no reliable way to detect a transfer.

### 2. Show replays without passing them through the session middleware

Give `OutputGate` two outputs: one for the replay passed to `open(snapshot)`, one for held and live output. `TomuxPaneSession` sends the replay straight to the tab, doing what `BaseSession` does with what its middleware lets through (`output.next(text)` and `binaryOutput.next(buffer)`). Live output keeps going through `emitOutput`.

`output` and `binaryOutput` are `protected` members declared in tabby-terminal's published typings for `BaseSession`. Calling them from tomux still depends on how `BaseSession` works inside (what runs after the middleware, and the initial output buffer it skips), so the two calls live in `showPastSessionMiddleware()` in `src/tabbyAdapter.ts`, listed in that file's header with the other Tabby internals. `paneSession.ts` only calls that function. tabby-tmux calls the same two subjects for the same reason.

Ordering: `OutputGate.open` calls the replay output synchronously, then hands the held output to the live output. Tabby's own middleware passes data through synchronously, so the replay is shown first in every case:
- **Adopt and reconnect redraw:** the tab calls `setSession` before `start()`, so it is subscribed when the replay arrives. `setSession` on a tab whose terminal is ready releases Tabby's initial output buffer at once (through `sessionChanged$`); if it hasn't been released yet, held output waits in that buffer until the tab releases it after `start()`. Either way it comes after the replay. The order does not rely on the buffer.
- **Pane switch:** the buffer is long released, and the same synchronous order applies.

Alternatives considered:
- **Remove trzsz's start line from replayed text.** It ties tomux to trzsz's format, and other middleware (Tabby's OSC processor, which picks up working-directory reports) would still see old history.
- **Take trzsz's middleware out of the stack during a replay.** It means reaching into another plugin's state.
- **Call `output` / `binaryOutput` from `paneSession.ts`.** They are declared protected members of the base class, but the call depends on `BaseSession`'s inner workings, which CLAUDE.md keeps in `tabbyAdapter.ts`. Chosen against after code review.

### 3. Keep the encoder for uploads and measure

Base64 consists of letters, digits, `+` and `/`, all of which go out as `send-keys -lt` literal runs of about 1,000 characters each, packed into lines of up to 8 KB. Record upload throughput in `doc/TESTING.md` rather than optimising before there is a number.

## Risks / Trade-offs

- [Ctrl-J, or a bare LF pasted on Windows, now reaches programs as a line feed instead of Enter] → This is what a Tabby SSH tab does. Shells and line-mode input treat both as end of line. Programs that bind Ctrl-J (`fzf`, `nano`) now behave as they do over plain SSH. Recorded in the proposal as a behaviour change.
- [tmux 2.x may write something other than `0a` for `C-j`] → Checked only on tmux 3.4 (locally, with a stand-in for `tsz`). The user's host showed the old behaviour (`0d` for Ctrl-J), not the new one. The unit test covers the command. The manual check (task 4.2) records what the host's tmux writes.
- [With tmux's `extended-keys` option on (off by default) and a program in the pane asking for extended keys, tmux may send `C-j` as an escape sequence instead of `0a`] → Not tested. Sending `\n` as hex `0x0a` is not a known fix: tmux may read it as the same Ctrl-J key. Task 4.2 checks it; change the encoding only if the check shows the problem.
- [If the session is also attached by another client, trzsz's `tmux display-message` may report that client, so trzsz may not detect control mode (binary mode, or writing to the other client's terminal)] → Not tested. The README states it. tomux can't choose the client tmux reports.
- [A replay sent directly could overtake output still inside the middleware (for example trzsz holding output during a transfer while the active pane changes)] → A transfer and a pane switch at the same moment is an edge case. The transfer would fail its own check and report an error rather than corrupt a file.
- [Large downloads depend on tmux keeping up with a control-mode client] → trzsz checks each file. The reliability pass measured about 1.8 MB/s of output without `pause-after`. Record a large `tsz` in `doc/TESTING.md`.
- [Upload speed is unknown] → Measure it (decision 3). A faster path is a separate change.
- [The end-to-end checks need a running Tabby with tabby-trzsz and `trzsz` on the host] → If the implementing session can't do this, say so in the final report and leave the manual task unticked.

## Migration Plan

None. Reverting the change restores the old behaviour. No settings or stored state are involved.
