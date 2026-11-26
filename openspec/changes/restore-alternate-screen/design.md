# Design

## Context

`TomuxPaneSession` draws a pane from tmux in three places: `start({ adopt })` for a tab adopting a window (new tab or restored tab), `start({ adopt, redraw: true })` for a reconnecting tab, and `switchPane` when tmux's active pane changes. All three use `captureSnapshot`, which calls `TmuxControlClient.captureWithCursor`. That sends `capture-pane -p -e -J -S - ; display-message "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"` as one line, so the cursor belongs to the captured screen. `OutputGate.captureStarted` runs at the capture's `%begin` and drops held output that the capture already contains. The gateway calls that `onBegin` hook at `%begin` even when the command then ends in `%error`.

Two redraws (reconnect and pane switch) put `CLEAR_SCREEN` (`ESC[0m ESC[2J ESC[3J ESC[H`) before the capture. That clears whichever screen the tab's terminal is on.

tmux facts, checked with tmux 3.8 (see the proposal for what is not checked):
- While a pane is in the alternate screen, `capture-pane -S -` returns the history and the alternate screen, and `capture-pane` without `-S` returns only the alternate screen. `capture-pane -a` returns the screen tmux saved when the program entered the alternate screen (the shell's screen), and fails with "no alternate screen" otherwise.
- `#{alternate_on}` is 1 in the alternate screen. `#{alternate_saved_x}` and `#{alternate_saved_y}` are the cursor tmux restores on leaving it, and 4294967295 when none was saved (the program used `?47h`).
- The history stays in the pane's grid while the program runs (tmux stops adding to it). `capture-pane -S - -E -1` returns it, but returns the first screen line instead when the history is empty. `#{history_size}` tells the two apart.
- `#{cursor_flag}` is 0 when the program hid the cursor. `#{mouse_standard_flag}`, `#{mouse_button_flag}` and `#{mouse_all_flag}` are modes 1000, 1002 and 1003, of which tmux keeps at most one; `#{mouse_sgr_flag}` and `#{mouse_utf8_flag}` are encodings 1006 and 1005. tmux has no format for bracketed paste. An unknown format expands to an empty string.
- `%output` passes the program's own `ESC[?1049h` / `ESC[?1049l` through to the tab unchanged.
- A command that fails ends the line: tmux skips the later commands of the same line (the gateway settles them as skipped).
- `if-shell -F` runs its commands as separate reply blocks after its own empty block, which the gateway's one-reply-per-command matching can't follow.

xterm.js facts, checked with `@xterm/headless` 5.5 and again in `src/paneRedraw.spec.ts` with 6.0 (the major version Tabby uses): `ESC[?1049h` saves the cursor (with the text style), switches to the alternate screen and clears it. `ESC[?1049l` switches to the normal screen if needed and always restores the saved cursor and style. On a terminal that never saved one, that puts the cursor in the top-left corner.

## Goals / Non-Goals

**Goals:**
- After every redraw, the tab's terminal is on the same screen as the pane, with both screens' content and both cursors where tmux has them, and with the pane's cursor visibility and mouse mode.
- No extra round trip for a pane that is not in the alternate screen.

**Non-Goals:**
- Restoring other terminal settings (bracketed paste, application keypad and cursor keys, scroll region). The README lists the limitation.

## Decisions

### 1. Capture as today, then capture both screens only when needed

`captureWithCursor` sends the same line as today. Its `display-message` reads, separated by `|` so an empty field keeps its place: `cursor_x`, `cursor_y`, `pane_width`, `pane_height`, `alternate_on`, `alternate_saved_x`, `alternate_saved_y`, `history_size`, `cursor_flag`, `mouse_standard_flag`, `mouse_button_flag`, `mouse_all_flag`, `mouse_sgr_flag`, `mouse_utf8_flag`. If `alternate_on` is not `1`, the result is today's result plus the modes.

If it is `1`, a second line follows:

```
capture-pane -p -e -J -a -t P ; capture-pane -p -e -J -S - -E -1 -t P ; capture-pane -p -e -J -t P ; display-message -p -t P "<same format>"
```

- `-a` comes first. If the program left the alternate screen between the two lines, it fails, tmux skips the rest, and tomux starts again from the first line. After three failed second lines, tomux sends the first line once more and draws that capture as a normal pane, whatever it reports. It doesn't reuse an earlier first-line capture, because the failed `-a`'s `%begin` has already dropped the held output that came after it.
- The history capture is ignored when `history_size` from the same line is 0.
- The `display-message` at the end of the same line gives the cursor, saved cursor, history size and modes that belong to these captures.
- `onCaptureStart` runs at the `%begin` of each line's first capture. Calling `OutputGate.captureStarted` again is safe: output held before the newer capture is in it.
- A saved cursor that is not a number within the pane is treated as "none saved".

The result keeps `text` as the normal screen (history and shell screen), adds `alternate?: { text, savedCursor?: { x, y } }` with `cursorX`/`cursorY` the program's cursor, and adds `modes: { cursorVisible, mouse }`.

Alternatives considered:
- *Ask `#{alternate_on}` first, then capture.* Always two round trips, and the state could change between them unless it is asked again anyway.
- *One line for every pane, with `-a` last.* `-a` fails for most panes, so almost every capture would end in an error reply, and this still needs the history split from the alternate screen.
- *`if-shell -F '#{alternate_on}'`.* Atomic, but its replies arrive as extra blocks (see Context).
- *Split `capture-pane -S -` into history and screen by line count.* `-J` joins wrapped lines, so the count doesn't match `#{history_size}`.
- *Avoid sending the history twice by capturing only the screen in the first line.* Then a normal pane, the common case, would need a second line too.

### 2. The redraw switches the tab's screen explicitly

`captureSnapshot` builds:
- normal pane: `RESET + text + RESET + CUP(cursor) + modes` (today's redraw plus modes);
- alternate pane: `RESET + text + RESET + [CUP(saved)] + ESC[?1049h + ESC[H + RESET + alternate.text + RESET + CUP(cursor) + modes`.

`CUP(saved)` before `ESC[?1049h` makes xterm.js save the cursor that the program's later `ESC[?1049l` restores. `ESC[?1049h` clears the alternate screen but doesn't move the cursor, so `ESC[H` puts the program's screen at the top. (Found in Tabby, task 4.3: without it, a program screen shorter than the terminal, or a saved cursor above the last row, was drawn from the saved cursor's row.) It is left out when none was saved. `ESC[?1049h` also saves the text style, which is the default here because of the reset before it.

`CLEAR_SCREEN` becomes `ESC[?1049l + RESET + ESC[2J ESC[3J ESC[H`. Reconnect and pane switch therefore always clear the tab's normal screen and its scrollback, whichever screen the tab was on. The reset comes after `ESC[?1049l` because restoring the cursor also restores the style saved with it.

A tab adopting a window without a redraw (new or restored tab) gets no `ESC[?1049l`: its terminal is new and on the normal screen, and restoring a cursor saved by nobody would move the cursor to the top-left corner, over Tabby's connection messages.

Alternative considered: *track in tomux which screen the tab is on by watching `%output` for `?1049h/l`, `?1047`, `?47`.* More code and state for the same result, and a sequence split across `%output` chunks would be missed.

### 3. Cursor visibility and mouse mode come from tmux on every redraw

`modes` is written at the end of the redraw, after the cursor is placed:
- `ESC[?25h` or `ESC[?25l` from `cursor_flag`; an empty field (unknown format) counts as shown.
- `ESC[?1000l ESC[?1002l ESC[?1003l ESC[?1005l ESC[?1006l`, then `ESC[?1003h`, `ESC[?1002h` or `ESC[?1000h` for the mode tmux reports (all, button, standard, in that order of preference), then `ESC[?1006h` or `ESC[?1005h` for the encoding.

It goes on every redraw, including a plain adopt, where it only sets what the program has on. For an alternate pane it is written after `ESC[?1049h`, so it is the program's state. xterm.js keeps these settings across a screen switch, like tmux, so when the program exits and turns them off itself the shell gets the defaults.

Alternative considered: *only reset the settings in `CLEAR_SCREEN`.* That fixes the shell after a program exits while disconnected, but a restored or reconnected tab of a running program would lose its mouse and show a cursor it hid.

### 4. Only the latest capture is drawn

`TomuxPaneSession` numbers its captures. `start` and `switchPane` open the gate only with the latest one; an out-of-date capture is dropped, and the gate keeps holding for the latest. Its `onCaptureStart` doesn't call `captureStarted` either, because output held after the latest capture began must not be dropped. Today every capture is one line, so tmux answers them in the order they were sent; a pane in the alternate screen needs a second line, so a later pane's capture can now arrive first.

## Risks / Trade-offs

- [A line wrapped from the last history line onto the first screen line is drawn as two lines when the pane is in the alternate screen, because the history and the shell's screen are captured separately] → Cosmetic, only in the shell's history behind a running program. Today's capture of a normal pane is unchanged.
- [The tab's rows differ from the pane's rows when it was captured, so `CUP(saved)` and `CUP(cursor)` point at the wrong rows] → The same for `CUP(cursor)` today. The tab sends its size to tmux before capturing, so the sizes normally match. Checked in Tabby with a resized restore (task 4.3).
- [tmux older than 3.x may lack a format or `capture-pane -a`] → An unknown format expands to an empty field, so `alternate_on` is not `1` and the pane is drawn as today, with the cursor shown and the mouse off. Not checked on tmux 2.1.
- [The program enters and leaves the alternate screen repeatedly during the capture] → At most three extra round trips and one more first line, then a normal capture.
- [The history is sent twice for a pane in the alternate screen, more with retries] → Accepted; see the proposal's Impact.
- [xterm.js versions differ from the one checked] → `?1049h/l`, `?25` and the mouse modes are standard xterm behaviour. Checked in a running Tabby as part of the tasks.
