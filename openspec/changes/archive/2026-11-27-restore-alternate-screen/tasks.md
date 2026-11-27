# Tasks

## 1. Capture both screens and the modes

- [x] 1.1 Extend `captureWithCursor` in `src/tmux/controlClient.ts`: the `display-message` reads the `|`-separated fields of design decision 1, and the result adds `modes` (cursor visibility, mouse mode and encoding). Verify with `controlClient.spec.ts` tests for the one-line command, a normal pane needing one line only, the modes parsed, and empty fields (unknown formats) read as a normal pane with the cursor shown and the mouse off
- [x] 1.2 When `alternate_on` is `1`, send the second line (`-a`, history with `-S - -E -1`, screen, `display-message`) and return `text` (history and shell screen), `alternate` (screen and saved cursor) and the program's cursor and modes. Verify with `controlClient.spec.ts` tests for: the second line's exact command, an empty history (`history_size` 0) being ignored, a saved cursor of 4294967295 read as none, `onCaptureStart` running at each line's first `%begin`
- [x] 1.3 Retry from the first line when the second line fails, up to three failed second lines, then send the first line once more and return it as a normal pane. Verify with `controlClient.spec.ts` tests for one failed second line followed by a normal pane, and for three failures followed by a fresh first line

## 2. Draw both screens and the modes

- [x] 2.1 In `src/paneSession.ts`, build the alternate-pane redraw and add the modes to every redraw (design decisions 2 and 3). Verify with `paneSession.spec.ts` tests for adopting a window in the alternate screen (with and without a saved cursor) and for the modes of a normal pane, using `FakeTmux` overrides
- [x] 2.2 Change `CLEAR_SCREEN` to start with `ESC[?1049l` before the reset; a plain adopt gets no `ESC[?1049l`. Verify with updated `paneSession.spec.ts` tests for reconnect, pane switch and plain adopt
- [x] 2.3 Number captures in `TomuxPaneSession` and draw only the latest; an out-of-date capture neither opens the gate nor calls `captureStarted` (design decision 4). Verify with a `paneSession.spec.ts` test that switches to a pane in the alternate screen and straight on to a normal pane: the tab ends with the normal pane's redraw and the output it printed after its capture

## 3. Check the result in a terminal emulator

- [x] 3.1 Add a `paneSession.spec.ts` test that feeds the session's output and then the program's exit (`ESC[?1049l` and a shell line) into `@xterm/headless`, if it can be added as a dev dependency without being bundled, and checks the screen shows the shell's screen with no program text. Otherwise check the emitted sequence only and record the headless xterm.js check from the design in `doc/TESTING.md`. Verify with `npm test`

## 4. Docs and checks

- [x] 4.1 README "Limitations": a redrawn tab doesn't restore terminal settings other than cursor visibility and mouse mode (such as bracketed paste) until the program sets them again. Verify by reading the section
- [x] 4.2 Run `npm run typecheck`, `npm test` and `npm run build` and verify they pass with no new build warnings; run `openspec validate restore-alternate-screen --strict` and verify it passes
- [x] 4.3 In a running Tabby against a real tmux, check the spec's scenarios: exit Claude Code after a Tabby restart, restore while it runs (no cursor shown), exit while disconnected then reconnect (cursor shown, mouse wheel scrolls), Reconnect while it runs then exit, a plain shell tab after restart, and a restore into a tab of a different size. Record the results in `doc/TESTING.md`, or say which could not be run

## Workflow follow-up

- Archive the change once it is merged and the Tabby checks are recorded.
