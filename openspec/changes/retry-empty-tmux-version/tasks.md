## 1. Diagnostics (already written on this branch, uncommitted; verify and tick)

- [x] 1.1 `SshControlTransport.readTmuxVersion` records whether `willDestroy$` fired during the check and ends the "no output" message with `SSH session destroyed: yes|no`; tests in `src/sshTransport.spec.ts` cover both values (spec: "Empty tmux version reply names its diagnostics")
- [x] 1.2 `sshSessionNumber` in `src/sshTransport.ts` numbers SSH session objects, with a test
- [x] 1.3 `describeIntent` in `src/binding.ts` formats a bind intent for the log, with a test
- [x] 1.4 `TomuxTabComponent.connect` logs which SSH session its tmux connection used and whether it opened, shared or failed (wording in design D5)
- [x] 1.5 Review fix: `readTmuxVersion` watches `willDestroy$` from before it opens the channel, and counts the subject completing as destroyed too (Tabby completes it in `destroy()`, so a late subscriber only sees `complete`); test a session destroyed while the channel is opening
- [x] 1.6 Review fix: the log line names the SSH session tmux runs on, not the tab's own. `TomuxConnection.open` takes a `sessionLabel` option and exposes it; a tab that shares logs the connection's label, and a failed tab says whether it opened the attempt (with its session) or joined another tab's

## 2. Empty-reply error type

- [x] 2.1 Add `TmuxVersionNoOutputError` (message plus `sessionDestroyed`) to `src/tmux/transport.ts`, and note on `readTmuxVersion` that it throws it for an empty reply
- [x] 2.2 Throw it from `SshControlTransport.readTmuxVersion` for empty output, keeping the message text; extend the existing empty-output tests to check the type and `sessionDestroyed`

## 3. Retry in the version check

- [x] 3.1 Add `warn?: (message: string) => void` to `TomuxConnectionOptions` and pass it to `checkTmuxVersion`
- [x] 3.2 Let `FakeTmux` script one reply per `readTmuxVersion` call (a string or an error), and count the calls
- [x] 3.3 Write failing tests in `src/tmux/connection.spec.ts` for the "Empty tmux version reply is retried once" scenarios: second attempt answers (connects, one warning with the first message, two calls); both empty (`TmuxVersionError` with the second message, no channel opened, transport released); session destroyed (no second call, error shown); and no retry for a non-empty failure (a plain `Error`, or `tmux` missing)
- [x] 3.4 In `checkTmuxVersion`, retry once on `TmuxVersionNoOutputError` with `sessionDestroyed` false, warning first; make the tests pass
- [x] 3.5 Pass a `warn` callback from `TomuxTabComponent.connect` to `TomuxConnection.open` that logs the message as a warning with the SSH session and tab appended

## 4. Second code review fixes

- [x] 4.1 `readTmuxVersion` starts its deadline before opening the channel and closes a channel that opens late; test a channel that never opens (spec: "Version check gives up in time")
- [x] 4.2 A failed retry reports both attempts: `<second> (first attempt: <first>)`; update the "Second attempt fails too" test, and add one where the second attempt fails with a different error
- [x] 4.3 Move the tab's log-line wording into `connectionLogLine` in `src/connectionLog.ts`, with tests for opened, shared, failed as opener and failed as joiner, and the retry warning's suffix; use it in `TomuxTabComponent.connect`
- [x] 4.4 Design and tasks quote the log lines the code writes (design D3, D5; tasks 1.4, 3.5)
- [x] 4.5 `FakeTmux` copies `versionReplies` instead of consuming the caller's array; test that two fakes built from one options object both see the replies

## 5. Verification

- [x] 5.1 `npm run typecheck`, `npm test` and `npm run build` pass with no new build warnings
- [ ] 5.2 Deploy to Tabby and confirm tabs still connect normally against a real tmux; check the log for the connection lines
- [ ] 5.3 When the empty reply happens again in a running Tabby, check that the warning appears and the tab connects; record the result in `doc/TESTING.md`
