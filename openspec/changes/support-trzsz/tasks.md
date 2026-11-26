# Tasks

## 1. Line feed reaches the pane as a line feed

- [x] 1.1 In `src/tmux/sendKeys.spec.ts`, change the expectation in "sends Enter, Tab, Backspace and control keys by name" so `\n` gives `send-keys -t %3 C-j`, fix the `KEY_NAMES` comment (line 8) that says `\n` maps to Enter, and add a test that a trzsz-style reply `#ACT:eyJ0ZXN0IjoxfQ==\n` ends in `send-keys -t %3 C-j` with `\r` nowhere in the decoded result; verify with `npm test` that both fail against the current code
- [x] 1.2 Remove the bare `\n` → Enter branch in `encodeSendKeys` (design decision 1), renumber the step comments, and add the change to the "Changes:" line of the ported file's header; verify the tests from 1.1 pass and no other `sendKeys.spec.ts` expectation changed (`\r` still gives `Enter`)

## 2. Replays bypass the session middleware

- [x] 2.1 In `src/outputGate.spec.ts`, add tests that `open(snapshot)` hands the snapshot to a separate replay output and held/live output to the live output, in that order, for both the first open and an open after `hold()`; verify they fail against the current single-callback gate
- [x] 2.2 Give `OutputGate` separate replay and live outputs (design decision 2) and update its doc comment; verify the tests from 2.1 and the existing `outputGate.spec.ts` tests pass
- [x] 2.3 In `src/paneSession.spec.ts`, extend the mocked `BaseSession` with `output` / `binaryOutput` subjects and an `emitOutput` that records separately, so a test can tell what bypassed the middleware. Add tests: an adopted snapshot, a reconnect redraw and a pane-switch redraw (marker, clear and capture) go only to the direct path; output held during the capture and later `%output` go only through `emitOutput`, after the replay; a captured line `::TRZSZ:TRANSFER:S:1.1.8:1732600000000:0` never reaches `emitOutput`. Keep the existing start tests passing by reading the combined output. Verify the new tests fail against the current code
- [x] 2.4 In `src/paneSession.ts`, send replays straight to `output` and `binaryOutput` and keep live output on `emitOutput` (design decision 2), with a comment explaining why replays skip the middleware; verify all of `npm test` passes
- [x] 2.5 After code review, move the two `output` / `binaryOutput` calls into `showPastSessionMiddleware()` in `src/tabbyAdapter.ts` (listed in its header with the other Tabby internals) and correct the ordering comment in `paneSession.ts` and design decision 2; verify a new `tabbyAdapter.spec.ts` test (both subjects get the data, the middleware gets nothing) fails first and then passes, and all of `npm test` passes

## 3. Documentation

- [x] 3.1 Add a short README section on tabby-trzsz: works in tomux tabs; needs `trzsz` on the host; transfers use base64 under tmux; uploads go through `send-keys`, and Ctrl-J now reaches programs as a line feed as in an SSH tab. Verify the README makes no claim that tasks 4.2–4.4 did not confirm (adjust or drop the speed wording to match)

## 4. Integration

- [x] 4.1 Run `npm run typecheck`, `npm test` and `npm run build`; verify all pass and the build shows no new warnings
- [ ] 4.2 In a running Tabby with tabby-trzsz, against a real tmux with `trzsz` installed, check the raw-mode scenarios in `specs/tmux-window-tabs/spec.md` (Ctrl-J reads `0a`, Enter reads `0d`), once with tmux's defaults and once with `extended-keys on` and a program that turns extended keys on (design risks), then `tsz` a file of a few MB and `trz` one back, comparing checksums on both sides; record results, tmux and trzsz versions in `doc/TESTING.md`
- [ ] 4.3 In the same setup, after a finished transfer, use Reconnect on the tab, restart Tabby so the tab is restored, and switch the window's active pane in tmux to a pane that also ran `tsz`; verify no dialog opens and nothing is typed into the shell, then run `tsz` again and verify it still starts; record in `doc/TESTING.md`
- [ ] 4.4 Measure `trz` upload and `tsz` download throughput for one file of at least 10 MB and record both in `doc/TESTING.md`

If 4.2–4.4 cannot be done in the implementing session, say so in the final report and leave them unticked.

## Workflow follow-up

- Archive the change once the manual checks are recorded and the PR is merged.
