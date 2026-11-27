## Context

See proposal.md for the bug. The facts that shape the fix:

- A tomux tab's terminal is as tall as the tab, and tomux sizes the tmux window from the tab. The shown pane can be shorter when the window has other panes. tmux sends the pane's output unchanged (`%output`), written for a terminal as tall as the pane. Nothing in the tab knows the pane's height after a redraw.
- The pane session's output path is `%output` → `PaneOutputNormalizer` → `OutputGate` (holds output while a capture runs) → the terminal. Redraws (`renderCapture` in `src/paneRedraw.ts`) go through the same gate. Since the `keep-unshown-tab-window` branch, a redraw writes its text in a scroll region of the pane's height and then resets the region to the whole tab.
- Checked in headless xterm.js 6.0.0, the version Tabby bundles:
  - The scroll region (DECSTBM) belongs to each screen buffer. The alternate screen starts with the whole screen as its region, and the normal screen keeps its region when a program leaves the alternate screen.
  - A resize, DECSTR (`ESC[!p`) and RIS (`ESC c`) set the region back to the whole screen. So do `?1047` and `?47`, like `?1049`.
  - A DECSTBM whose bottom row is past the screen sets the whole screen.
  - `ESC 7`, DECSTBM, `ESC 8` sets the region and leaves the cursor where it was (DECSTBM alone moves it home).
  - Lines that scroll off a region starting at the top row go to the scrollback.
- When tmux changes a pane's height, it moves the pane's lines and cursor without any output (checked on tmux 3.8). A shorter pane deletes empty rows below the cursor, then pushes its top lines into the history; the cursor moves up with them (unzoom: from row 24 to row 10). A taller pane pulls lines back from the history; the cursor moves down (zoom: from row 10 to row 16). The tab's terminal sees none of it. When the pane is as tall as the window, the tab's terminal is resized with it and moves its lines the same way.
- With `pane-border-status top` or `bottom`, tmux draws the status line inside the layout cell of each pane at the window's top or bottom edge, and that pane is one row shorter than its cell (tmux 3.8: a lone pane of a 25-row window is 24 rows; with `top`, a 12-row top cell holds an 11-row pane). The layout string shows only the cells.
- tmux sends `%layout-change @win <layout> <visible-layout> <flags>` when a window's panes change size. tmux 3.8 control mode still uses the classic layout string (`928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]`, each pane `WxH,X,Y,<pane number>`). The visible layout shows a zoomed pane alone at the window's full size (`b55d,40x25,0,0,0`, flags `*Z`), and tmux repeats a layout change that changed nothing. `TmuxGateway` already parses the line into `layout-change` events but nothing listens to them. Gateway events are emitted in the order of tmux's lines, so a layout change and the pane's output arrive in order.

## Goals / Non-Goals

**Goals:**
- Live output in a short pane scrolls exactly as tmux scrolls the pane, without tomux reading or redrawing anything.
- After the pane's height changes, the tab shows the pane as tmux has it, lines and cursor.
- The pane height used for each piece of output is the height tmux had when it sent that output.

**Non-Goals:**
- Showing the window's other panes in the rows below the pane.
- Panes narrower than the tab (see proposal).
- Repairing the drift on branches without this change. The next redraw already repairs it there.

## Decisions

**1. Keep a DECSTBM of the pane's height in the tab's terminal.** The terminal then scrolls the pane's rows for every way output can scroll: line feeds, IND/NEL/RI, CSI S/T, insert and delete line. The scrollback also fills as it does for a full-height pane. Alternatives rejected:
- *Make the terminal as tall as the pane*: Tabby fits the terminal to the tab, and tomux sizes the tmux client from the terminal's size, so this needs Tabby internals and a second notion of size.
- *Rewrite the scrolling sequences in the output*: there are many of them, and the cursor position they depend on is only known inside the terminal.

**2. A small output step, the pane rows keeper, keeps the region in place.** It runs on the text the gate lets through, and knows the pane height (0 = unknown, then it passes everything through unchanged):
- A program's DECSTBM `CSI Pt;Pb r` is rewritten so its bottom is at most the pane height. A missing or 0 bottom becomes the pane height, and a missing top becomes 1. The terminal moves the cursor home as for the original. Only plain DECSTBM is touched: not `CSI ? … r` (XTRESTORE) and not sequences with intermediates such as `CSI … $ r`.
- After a sequence that gives the region back to the whole screen without the program asking for a region, it inserts `ESC 7 ESC[1;<h>r ESC 8`: `CSI ? … h/l` with 1049, 1047 or 47 among its parameters, and DECSTR. After RIS it inserts `ESC[1;<h>r` alone, since RIS puts the cursor home anyway.
- An escape sequence cut across two `%output` chunks is held, up to 64 characters, until the next chunk completes it, so a split reset is not missed. A longer unfinished sequence is let through as it is.

The alternative, hooking xterm.js's parser for `r`, needs the terminal object (Tabby internals) and cannot change the parameters the default handler uses.

**3. Height changes travel through the gate in order.** The gate holds entries of four kinds: text, a capture's redraw with the pane's and window's rows it was taken at, "the pane is now `h` rows in a window of `w` rows", and "re-apply the region". The keeper applies the rows when the gate lets an entry through, so held output is processed with the height tmux had when it sent it:
- When a capture's snapshot is shown, its rows are applied first. `renderCapture` now leaves the region at the pane's height instead of resetting it to the whole tab, on the normal screen and on the alternate screen it draws. The capture also reads `#{window_height}`.
- When a `%layout-change` for any window comes in, the session looks up its own pane number in the visible layout, and if it is there it pushes a rows entry; the keeper ignores a height that did not change. The visible layout is used so that zoom counts. A layout without the pane (another pane zoomed, another window) changes nothing.
- When Tabby resizes the session (`TomuxPaneSession.resize`), the session pushes a re-apply entry at the current height, because the terminal's resize cleared the region. The layout change that follows from tmux brings the new height.

The alternative, asking tmux for `#{pane_height}` on each layout change, answers asynchronously, after output that already uses the new height.

**4. The layout string is parsed with a small pure function**: the cell of pane number `n` in a classic layout string (its height, whether it touches the window's top or bottom edge, the window's height), or null. A second function gives the pane's rows from the cell and `pane-border-status`, which the session reads when it starts, before its gate opens; a layout change is turned into rows when the gate lets it through, so one held before the reply comes counts right. A tab that gets no reply in time counts the option as off. It finds `WxH,X,Y,n` leaves (a container's `X,Y` is followed by `{` or `[`, not by `,n`), and is unit-tested with the strings above. The JSON layout that `#{window_layout}` prints in tmux 3.8 is not used, because control mode doesn't send it.

A redraw replaces the output before it, so the keeper drops an unfinished escape sequence it held from that output. A pane switch whose capture fails leaves the new pane's rows unknown: the keeper passes output through, and the next layout change of a shorter pane draws it.

**5. A pane shorter than its window is drawn again when its height changes.** When a rows entry passes the gate with another height than the tab shows, and the pane is or was shorter than its window, the session draws the pane again from a new capture, as a pane switch does but without the title marker: the gate holds, the capture drops older output, the tab is cleared and redrawn. A pane as tall as its window before and after (one pane, zoomed) is not drawn again: the tab's own resize moves its lines as tmux does. Rows not known yet (a new window before its first layout change) count as as tall as the window, except when the new rows are shorter. A capture that fails leaves the tab as it is. A layout change during a capture is held and compared with the capture's rows when it is shown, so it starts at most one more capture. Alternatives rejected:
- *Copy tmux's move with escape sequences*: which lines move depends on the cursor's row, which only the terminal knows; asking it (DSR) answers asynchronously through the input path.
- *Accept the gap until the next redraw*: after a shorter pane (unzoom, a smaller Tabby window, `resize-pane`) the tab's cursor can be below the region, where line feeds don't scroll, so new output overwrites the tab's last row.

## Risks / Trade-offs

- [`ESC 7`/`ESC 8` overwrite the saved cursor of the active screen] → They are only inserted right after a screen switch, DECSTR, a resize or a change of height of a pane as tall as its window, and they save the cursor and restore it at once. A program that saved its cursor before a layout change and restores it after gets the position it had at the change. After `?1049` switches, the saved cursor is the one the switch just used. A program that saves its cursor, switches with `?47`, comes back and then restores would get the position after the switch instead. This is rare and only affects programs that use `?47`.
- [A pane taller than the tab for a moment (tab shrinking before tmux follows)] → A bottom past the screen becomes the whole screen in xterm.js, which is today's behaviour, and the next layout change sets it right.
- [tomux's and Tabby's own messages (connection lost, "Press any key to reconnect") written while the region is set] → They scroll within the pane's rows like the pane's output. Acceptable: they are about that pane.
- [A future tmux sending another layout format in `%layout-change`] → The parser returns null and the height stays as captured. A pane switch or a redraw still sets it, and the parser's tests show the format it expects.
- [`pane-border-status` changed while a tab is open] → tmux sends nothing when an option changes, so the tab keeps the value it read when it started: its region is one row off until the tab is opened again (Reconnect or a restart). With the status line on, a lone pane is shorter than its window, so resizing the Tabby window draws it again.
- [A new tab waits for tmux's answer about `pane-border-status` before showing output] → One round trip, at most 1.5 seconds on a stalled connection; the output is held meanwhile, not lost.
- [A redraw on each height change of a short pane costs a full capture (`capture-pane -S -`) and rebuilds the tab's scrollback, so its scroll position and selection are lost] → It only happens when the shown pane's height changes and the pane is or was shorter than its window, not on output. Dragging the Tabby window sends several layout changes; a newer capture replaces an older one and only the latest is drawn.
- [Output written before the first capture of a session (height unknown)] → Passed through unchanged, as today. The gate holds it until the snapshot, which sets the height.
