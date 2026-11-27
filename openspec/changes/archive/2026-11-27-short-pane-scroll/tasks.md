# Tasks

## 1. Setup

- [x] 1.1 Run `npm ci` in this worktree (it has no `node_modules` of its own, and the main checkout's lacks `@xterm/headless`). Verify `npm test` passes before any change

## 2. Pane height from tmux's layout

- [x] 2.1 Add a pure function that returns the height of pane number `n` in a classic tmux layout string, or null (design decision 4), with a header comment naming the format. Verify with unit tests on the strings tmux 3.8 sent: one pane (`ba1d,97x25,0,0,0`), two stacked panes (`928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]`), side by side (`{…}`), nested containers, a zoomed visible layout, a pane that is not in the layout, and a malformed string
- [x] 2.2 Make `TomuxPaneSession` listen to the gateway's `layout-change` events as it does for `output`, and stop listening where it stops listening to `output`. Verify with a unit test using `src/tmux/fakeTmux.testing.ts` that a `%layout-change` naming the session's pane reaches it, and that one for another window does not change anything

## 3. Keep the region at the pane's height

- [x] 3.1 Add the pane rows keeper (design decision 2): rewrite plain DECSTBM to the pane height, insert `ESC 7 ESC[1;hr ESC 8` after `?1049`/`?1047`/`?47` set or reset (also inside a parameter list) and after DECSTR, insert `ESC[1;hr` after RIS, hold a split escape sequence up to 64 characters, and pass everything through when the height is 0. Verify with unit tests on the output strings, including `CSI ? … r` and `CSI … $ r` left alone, a split `ESC[` + `r`, and the 64-character limit
- [x] 3.2 Let `OutputGate` hold height entries as well as text, in order, and run the keeper where the gate emits (design decision 3). Push a height entry on a layout change that changes the pane's height, a re-apply entry from `resize()`, and apply a capture's `paneHeight` before its snapshot. Verify with `src/paneSession.spec.ts` tests: output held during a capture and a layout change in between come out in order with the right height, and a resize while holding re-applies after the snapshot
- [x] 3.3 Make `renderCapture` leave the region at the pane's height instead of resetting it to the whole tab, and update its comments and the `paneRedraw.spec.ts` and `paneSession.spec.ts` expectations. Verify with `npm test`
- [x] 3.4 Add headless xterm.js tests (`src/paneRedraw.spec.ts` or a new spec) for each spec scenario, feeding the redraw and then pane output through the keeper into a 25-row terminal: new lines on an 11-row pane's last row (rows 0 to 10 as expected, rows below empty, scrolled lines in the scrollback in order), a one-pane window unchanged, a program region of rows 2 to 5 then a reset, the alternate screen in and out, a terminal resize followed by output, the other pane closed (height 25), zoom and unzoom, and a pane switch from 7 to 17 rows. Verify each test fails without the keeper and passes with it
- [x] 3.5 Draw a pane shorter than its window again when its height changes (design decision 5): the layout parser also returns the window's rows, the capture reads `#{window_height}`, the gate carries a capture's redraw and its rows as one entry and keeps holding when an entry it lets through holds it again. Verify with unit tests: the redraw rule, a layout change that shortens a pane, zoom and unzoom, a pane as tall as its window resized without a redraw, a repeated layout change, a layout change during a capture, and in the xterm.js tests of 3.4 the tab made shorter and the pane unzoomed, right after the change and after new output
- [x] 3.6 Add one line to README "How it works" (next to "One tab per tmux window, one pane per tab") saying that a pane shorter than the tab is shown on the tab's top rows and scrolls within them. Verify the README matches the behaviour tested in 3.4 and 3.5
- [x] 3.7 Count the pane border status line out of the pane's rows (design decision 4): the parser returns the pane's cell, the session reads `#{pane-border-status}` before its gate opens (1.5 s timeout, then off) and turns a layout change into rows when the gate lets it through. Verify with unit tests: the rows tmux 3.8 gave with `top` and `bottom` for panes at either edge and a zoomed pane, a lone pane's layout change matching its capture without a redraw, a layout change held before the reply, no reply in time, and the spec scenario in xterm.js
- [x] 3.8 A pane switch whose capture fails forgets the pane's rows, and a redraw drops an unfinished escape sequence held from earlier output. Verify with `src/paneSession.spec.ts` tests

## 4. Checks

- [x] 4.1 Run `npm run typecheck`, `npm test` and `npm run build` and verify they pass with no new build warnings; run `openspec validate short-pane-scroll --strict` and verify it passes
- [x] 4.2 In a running Tabby against a real tmux, with a window split so the shown pane is shorter than the tab, check the spec's scenarios by comparing the tab's rows and cursor with `tmux capture-pane` and `display-message` of the pane: new lines on the pane's last row, a one-pane window, a program that sets and resets a scroll region, a full-screen program entered and exited, the Tabby window resized, the other pane closed, zoom and unzoom, and a switch to a pane of another height. Record the results in `doc/TESTING.md`, or say which could not be run

## Workflow follow-up

- Archive the change once it is merged and the Tabby checks are recorded.
