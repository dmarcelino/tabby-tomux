# Tasks

## 1. Failing tests first

- [x] 1.1 In `src/tmux/sendKeys.spec.ts`, add a test that `encodeSendKeys('\x1bOH\x1bOF', '%3')` returns `send-keys -t %3 Home` and `send-keys -t %3 End`, and a test that `\x1bOA\x1bOB\x1bOC\x1bOD` returns `Up`, `Down`, `Right`, `Left`; verify with `npm test` that both fail against the current code with hex output
- [x] 1.2 Add a test for the vim reproduction input `abc\x1bOHX\x1bOFY` expecting `send-keys -lt %3 abc`, `Home`, `send-keys -lt %3 X`, `End`, `send-keys -lt %3 Y` in that order; verify it fails for the same reason

## 2. Fix

- [x] 2.1 Add the six application-mode entries to `KEY_MAP` in `src/tmux/sendKeys.ts` (design decision 1) and add the change to the "Changes:" line of the file header; verify the tests from group 1 pass
- [x] 2.2 Rewrite the test "hex-encodes unknown sequences atomically (SS3 arrows, modified arrows)" so it uses an SS3 sequence that is still unknown (`\x1bOM`) next to `\x1b[1;5C` (design decision 2), and keep `KEY_NAMES` on the normal-mode forms (design decision 3); verify `npm test` passes with no other expectation changed

## 3. Integration

- [x] 3.1 Run `npm run typecheck`, `npm test` and `npm run build`; verify all pass and the build shows no new warnings
- [ ] 3.2 In a running Tabby against a real tmux, run the three scenarios in `specs/tmux-window-tabs/spec.md` (Home/End in vim insert mode, arrows in vim, Home/End at a shell prompt) and record the results in `doc/TESTING.md`; if this cannot be done in the session, say so in the final report and leave the task unticked
