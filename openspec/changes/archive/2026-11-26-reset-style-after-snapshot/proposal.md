# Proposal

## Why

Sometimes a tomux tab restored at Tabby startup shows Claude Code with almost every line underlined. The lines also carry the colour of the last styled text. A clear fixes it. The cause is how tmux builds its capture: `capture-pane -e` writes a style code only where a cell's style differs from the cell before. It never adds a reset at the end. When the bottom line of the pane ends on styled text with no unstyled cells after it, the snapshot leaves the terminal with that style switched on. In Claude Code this is the underlined `PR #42` link. The program's next redraw assumes the style is off, and every cell it writes picks the style up.

## What Changes

- After writing a captured snapshot, tomux resets the text style to the default (`ESC [ 0 m`), and only then moves the cursor to where tmux has it.
- The same leak can happen at the start of a snapshot: when a tab redraws after reconnecting, or follows a new active pane, earlier output in that tab may have left a style on. The clear-screen sequence and the snapshot therefore also start with the reset. This was found in code review, and it was a bug before this change.
- This covers every path that writes a snapshot. All of them go through `TomuxPaneSession.captureSnapshot`: adopting a window at startup or on restore, a reconnecting tab redrawing its window, and following a new active pane.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-window-tabs`: two new requirements. "Adopted screen does not leak text style" says that after a captured screen is drawn, the terminal is back to the default text style. "Adopted screen starts from the default text style" says the clear and the captured text start from the default style, whatever earlier output left on. "Output and scrollback" stays as it is.

## Impact

- Code: `src/paneSession.ts` (`captureSnapshot` and the clear-screen sequence), plus new tests in `src/paneSession.spec.ts`. The older adopt tests get the real cursor command, so they check the cursor move too.
- No API, dependency or configuration changes.
- What users see: restored tabs no longer show leaked underline or colours. The one trade-off: a program whose style was still switched on when the capture was taken loses it. The design covers why that's acceptable.
- `doc/TESTING.md` gets the result of the check in a running Tabby.
