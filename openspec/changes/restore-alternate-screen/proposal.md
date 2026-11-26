# Proposal

## Why

When a tomux tab is restored after Tabby restarts while a full-screen program such as Claude Code, vim or less is running, the program's screen is drawn into the tab's normal screen. tmux's `capture-pane` returns only the alternate screen and doesn't say the pane is in it. When the program exits, its "leave the alternate screen" sequence has nothing to switch back to. The cursor jumps to the top-left corner and the shell prints over the program's old screen. The user confirmed this in Tabby: the problem appears after a Tabby restart, but not after starting and exiting Claude Code or after Reconnect.

Reconnect and pane switches only work by luck: they draw on whichever screen the tab's terminal happens to be on. That goes wrong when the program enters or leaves the alternate screen while the tab is disconnected, or when tmux's active pane changes between a full-screen program and a shell. In those cases the tab also keeps the program's cursor visibility and mouse mode. After a program that hides the cursor, the shell prompt has no visible cursor. After vim with the mouse on, the mouse wheel types escape codes at the prompt.

## What Changes

- When tomux draws a window or pane from tmux (adopting a window, reconnecting, or following a new active pane), it asks tmux whether the pane is in the alternate screen, in the same tmux command line as the capture.
- If the pane is in the alternate screen, the tab gets the shell's history and screen (the screen tmux keeps behind the program) on its normal screen, with the cursor where the program will put it back when it leaves the alternate screen. The tab then switches to its alternate screen and draws the program's screen and cursor there. When the program exits, the tab shows the shell's screen as it was, followed by what the shell prints next.
- If the pane is not in the alternate screen, a redraw that clears the tab (reconnect, new active pane) first switches the tab to its normal screen, so a tab left on its alternate screen doesn't show the shell there.
- Every redraw from tmux sets the tab's cursor visibility and mouse mode to what tmux reports for the pane, so settings a program left on in the tab, or that the tab never got, are corrected.
- When the active pane changes again before an earlier pane's capture has arrived, the earlier capture is not drawn.
- Nothing changes for a pane that is not in the alternate screen when a tab adopts its window: it is captured and drawn as today, in one tmux round trip.

Out of scope:
- Other terminal settings a program turned on before the redraw, such as bracketed paste, application keypad and the scroll region. tmux reports no bracketed paste state at all. A redrawn tab doesn't have these until the program sets them again. The README lists this as a limitation.
- Windows with tmux's `alternate-screen` option off: tmux never reports the alternate screen there, and they are drawn as today.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tmux-window-tabs`: "Output and scrollback" no longer shows the history on the tab's visible screen while the pane's program is in the alternate screen. New requirements: a tab drawn from tmux shows the program's alternate screen as an alternate screen, and it takes the pane's cursor visibility and mouse mode.

## Impact

- **Code**: `src/tmux/controlClient.ts` (`captureWithCursor` also reads the alternate-screen state, saved cursor, history size, cursor visibility and mouse mode, and captures both screens when the pane is in the alternate screen), `src/paneSession.ts` (builds the redraw from both screens, switches the tab's screen explicitly, sets the two settings, drops out-of-date captures), and their unit tests.
- **Tabby APIs**: none new. Nothing goes into `src/tabbyAdapter.ts`.
- **tmux**: the formats `#{alternate_on}`, `#{alternate_saved_x}`, `#{alternate_saved_y}`, `#{history_size}`, `#{cursor_flag}` and `#{mouse_standard_flag}`, `#{mouse_button_flag}`, `#{mouse_all_flag}`, `#{mouse_sgr_flag}`, `#{mouse_utf8_flag}`, and `capture-pane -a` and `-E`. Checked on tmux 3.8 locally. Not checked on the oldest supported tmux (2.1). An unknown format expands to nothing, and tomux then draws the pane as today with the cursor shown and the mouse off.
- **Cost**: for a pane in the alternate screen, one extra round trip, and the pane's history is sent twice (the first capture is replaced by the second). Each retry (design decision 1) repeats that.
- **Docs**: README (limitation on other terminal settings), `doc/TESTING.md` (manual checks in Tabby).
- **Dependencies**: `@xterm/headless` (the version Tabby's xterm.js uses, 6.x) as a dev dependency, for unit tests that run the redraw through xterm.js. Only spec files import it; it is not bundled.
