## Why

A tomux tab shows the tmux window's active pane on its top rows. When the window has more than one pane, that pane is shorter than the tab. tmux scrolls the pane when a program prints a new line on the pane's last row, but the tab scrolls only at its own last row, so the tab's cursor moves below the pane instead. From then on the tab and the pane differ by one more row for each such line. Prompts appear too low, and programs that move the cursor write over the wrong rows. The tab is correct again only at its next redraw (restart, Reconnect, pane switch).

It was seen in a running Tabby against tmux 3.8 (recorded in `doc/TESTING.md`, "Redraw of a pane shorter than the tab"). An 11-row pane in a 25-row tab moved one row down after a program exited, and two more after one `echo`. It is in `main` and in every open branch: no branch limits live output to the pane's rows. The redraw fix on `keep-unshown-tab-window` sets a scroll region of the pane's height only while it draws, then gives the full tab back.

## What Changes

- A tab keeps its scrolling limited to the shown pane's rows, for live output as well as redraws. A new line on the pane's last row scrolls the pane's rows, and the line that leaves the top goes to the tab's scrollback, as it does today for a pane as tall as the tab.
- The limit is kept when something would remove it: a program setting or resetting its own scroll region, a program switching to or from the alternate screen, a terminal reset, and a resize of the tab.
- The limit follows the pane's height when it changes: the window's layout changes (a pane is added, closed, resized or zoomed), or the window's active pane changes.
- When the height of a pane shorter than its window changes, tmux moves the pane's lines and cursor without sending any output. The tab then draws the pane again from tmux, as it does on a pane switch.
- A window with one pane behaves as today: its pane is as tall as the tab, so the limit is the whole tab.

Out of scope:
- The tab's rows below a short pane stay empty. Showing the window's other panes there is the "splits are not supported" limitation, unchanged.
- A pane narrower than the tab (panes side by side). Lines don't wrap at the pane's width in the tab; that is a separate problem.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-window-tabs`: a new requirement, "A shorter pane scrolls within its rows": live output in a pane shorter than the tab scrolls within the pane's rows and keeps matching tmux, through program scroll regions, the alternate screen, layout changes, pane switches and tab resizes.

## Impact

- Code: the pane session's output path (`src/paneSession.ts`, `src/outputGate.ts`) gets a step that keeps the scroll region at the pane's height. `src/paneRedraw.ts` leaves the region at the pane's height after a redraw instead of giving the full tab back. The pane session listens to tmux's `%layout-change`, which the gateway already parses, to learn the pane's new height, and draws a short pane again when its height changes. The capture also reads the window's height (`src/tmux/controlClient.ts`).
- Tests: unit tests in headless xterm.js (`@xterm/headless`, already a dev dependency) for each case above, and `src/tmux/fakeTmux.testing.ts` for layout changes.
- No API, dependency or configuration changes.
- `doc/TESTING.md` gets the result of a check in a running Tabby with a split window. README's "How it works" gets one line on short panes.
