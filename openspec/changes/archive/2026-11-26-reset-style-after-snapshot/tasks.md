# Tasks

## 1. Failing test first

- [x] 1.1 In `src/paneSession.spec.ts`, add a test where `FakeTmux` answers `capture-pane -p -e -J -S - -t %0` with `['history line', 'next \x1b[4mlast']` and answers `display-message -p -t %0 "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"` with `['2 1 80 24']`. After `start({ adopt: true })`, the emitted text must contain `'next \x1b[4mlast\x1b[0m\x1b[2;3H'`. Run `npm test` and check that it fails on the current code, which emits `last\x1b[2;3H` with no reset.
- [x] 1.2 Add the same assertion for `switchPane('%0')` (design decision 2), after letting the capture settle. Check that it fails for the same reason.

## 2. Fix

- [x] 2.1 In `captureSnapshot` in `src/paneSession.ts`, put `'\x1b[0m'` between the captured text and the cursor move, and update the method's doc comment to say why (design decision 1). Check that the tests from group 1 pass and no other test changes.

## 3. Integration

- [x] 3.1 Run `npm run typecheck`, `npm test` and `npm run build`. Check that all three pass and the build shows no new warnings.
- [x] 3.2 In the Tabby running on this machine (a test install; its session need not be preserved): link the plugin to this worktree, build, restart Tabby with `TOMUX_DEV=1`, and check that `log.txt` contains `tomux plugin loaded`. Then run the spec's "Captured screen ends on underlined text" scenario with a script. In a tomux tab, the script draws a screen whose bottom row ends on `ESC[4m…ESC[0m` with nothing written after it, then keeps redrawing a line using only `ESC[33m…ESC[39m`. Quit and restart Tabby with that tab open. In DevTools, read the restored tab's xterm buffer and check that the redrawn cells are not underlined. Before the fix they would be, so also run the same check once on the unfixed build to show the bug reproduces. Also restore a tab running Claude Code and check it by eye. Record the results in `doc/TESTING.md`. If any step can't be done in the session, say so in the final report and leave the task unticked.

## 4. Code-review follow-up: reset at the start, cursor in the old tests

- [x] 4.1 In `src/paneSession.spec.ts`, set the older `CURSOR` override to the real four-field command, answering `['2 1 80 24']`, and assert that the adopt and redraw tests emit `\x1b[2;3H` after the history. Check that these assertions pass on the current code. They cover existing behaviour that was never checked.
- [x] 4.2 Add failing tests for the start-of-snapshot reset (design decision 1b). `start({ adopt: true, redraw: true })` output must start with `'\x1b[0m\x1b[2J\x1b[3J\x1b[H\x1b[0mhistory line'`. `switchPane('%0')` output must contain `'\x1b[0m\x1b[2J\x1b[3J\x1b[H\x1b[0mhistory line'` right after the marker. Change the existing assertion `startsWith('\x1b[2J\x1b[3J\x1b[H')` to the new prefix. Run `npm test` and check that they fail on the current code.
- [x] 4.3 Start `CLEAR_SCREEN` with `RESET_STYLE`, put `RESET_STYLE` in front of the captured text in `captureSnapshot`, and update both doc comments. Check that the tests from 4.1 and 4.2 pass, and run `npm run typecheck`, `npm test` and `npm run build` with no new warnings.

## Workflow follow-up

- Archive the change after review, and sync the delta into `openspec/specs/tmux-window-tabs/spec.md`.
