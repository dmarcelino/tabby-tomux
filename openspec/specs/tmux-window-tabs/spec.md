# tmux-window-tabs Specification

## Purpose

Shows each window of a tmux session as one native Tabby top-level tab with a single pane, and keeps the tab and its tmux window consistent for input, output, size, title and closing.

## Requirements

### Requirement: One tab per tmux window
Each tomux tab SHALL be bound to exactly one tmux window of its session, and no two tomux tabs in a Tabby window SHALL be bound to the same tmux window at the same time.

#### Scenario: New tab gets its own window
- **WHEN** the user opens a new tomux tab for a session that is already connected
- **THEN** tomux creates a new tmux window in that session and binds the tab to it

#### Scenario: Window created inside tmux
- **WHEN** a new window is created in the session from inside tmux (for example with the tmux new-window key binding) or by another tmux client
- **THEN** tomux opens a new tomux tab bound to that window

### Requirement: Single pane per window
tomux SHALL display only one pane per tmux window. tomux SHALL NOT create tmux panes, and Tabby's split actions on a tomux tab SHALL NOT bind two tabs to the same tmux window.

#### Scenario: Window that already has several panes
- **WHEN** tomux binds a tab to a tmux window that has more than one pane
- **THEN** the tab shows the window's active pane and the other panes keep running untouched

#### Scenario: User splits a tomux tab in Tabby
- **WHEN** the user uses Tabby's split action on a tomux tab
- **THEN** the new pane is not bound to the same tmux window as the original tab

### Requirement: Input reaches the pane unchanged
Everything the user types or pastes in a tomux tab SHALL reach the bound tmux pane in order and unchanged, including spaces, non-ASCII text, control keys and escape sequences.

#### Scenario: Fast typing with spaces
- **WHEN** the user quickly types `echo a b  c` and Enter
- **THEN** the shell runs `echo a b  c` with both spaces preserved

#### Scenario: Large paste
- **WHEN** the user pastes 100 KB of text into a tomux tab
- **THEN** the pane receives the complete text in order

#### Scenario: Escape sequences
- **WHEN** the user presses arrow keys in a full-screen program such as `vim`
- **THEN** the program receives each key as one intact sequence

### Requirement: Cursor keys work in application cursor mode
When the program in the bound pane has switched the terminal to application cursor mode, the Home, End and arrow keys SHALL reach the program as those keys, exactly as they do in normal cursor mode. They SHALL NOT arrive as an Escape key followed by letters.

#### Scenario: Home and End in vim insert mode
- **WHEN** the user opens `vim` in a tomux tab, enters insert mode, types `abc`, presses Home, types `X`, presses End and types `Y`
- **THEN** the buffer holds the single line `XabcY` and vim is still in insert mode

#### Scenario: Arrow keys in vim
- **WHEN** the user presses the arrow keys in `vim` in a tomux tab
- **THEN** the cursor moves one cell per key press and no letters are inserted

#### Scenario: Home and End at a shell prompt
- **WHEN** the user types `abc` at a shell prompt, presses Home, types `X`, presses End and types `Y`
- **THEN** the command line reads `XabcY`

### Requirement: Output and scrollback
A tomux tab SHALL show the bound pane's output as it is produced. When a tab binds to a tmux window that already existed, it SHALL first show that pane's existing scrollback and screen and place the cursor where tmux has it. While the pane's program is in the alternate screen, the scrollback and the screen behind the program SHALL be on the tab's normal screen, behind the program's screen.

#### Scenario: Adopting an existing window
- **WHEN** a tomux tab binds to an existing window with 2,000 lines of history
- **THEN** the tab shows that history and the current screen before any new output

### Requirement: Adopted screen does not leak text style
After a tomux tab draws a window's captured history and screen, the terminal SHALL be back to the default text style (no underline, bold, dim, italic, reverse or colours) before any newer output from the pane. Styling seen on the captured screen SHALL NOT carry over to text the program writes later.

#### Scenario: Captured screen ends on underlined text
- **GIVEN** a window whose bottom line ends on underlined, coloured text with no unstyled cells after it, such as Claude Code's status line ending in an underlined `PR #42` link
- **WHEN** a tomux tab adopts that window and the program then redraws the screen without changing the underline or colours first
- **THEN** the redrawn text is not underlined and has only the colours the program set

#### Scenario: Restored tab after Tabby restarts
- **WHEN** Tabby restarts with a tomux tab open on a window running Claude Code, and the tab is restored
- **THEN** the tab shows Claude Code with the same styling as a fresh attach, and no extra underline across the screen

#### Scenario: Active pane changes
- **WHEN** the window's active pane changes and the tab redraws the new pane from a capture
- **THEN** the new pane's later output is not styled by the end of that capture

### Requirement: Adopted screen starts from the default text style
When a tomux tab clears its screen to redraw a window or pane from a capture, the clear and the captured text SHALL start from the default text style, whatever style earlier output in the same tab left switched on. The clear SHALL paint with the default background, and unstyled captured cells SHALL be drawn unstyled.

#### Scenario: Earlier output stopped partway through an update
- **GIVEN** a tab whose last output switched underline and a colour on and never switched them off (the pane's output stopped partway through an update)
- **WHEN** the window's active pane changes, or the tab reconnects and redraws its window
- **THEN** the cleared screen has the default background, and the new capture's unstyled text is neither underlined nor coloured

### Requirement: Redrawn tab keeps the program's alternate screen
When a tomux tab draws a pane from tmux (adopting its window, reconnecting, or following a new active pane) and the pane's program is in the alternate screen, the tab SHALL show the program's screen on its own alternate screen. The shell's history and screen SHALL be on the tab's normal screen behind it, with the cursor where the program leaves it on exit. When the program leaves the alternate screen, the tab SHALL show the shell's screen and nothing of the program's.

#### Scenario: Exiting Claude Code after Tabby restarts
- **GIVEN** a tomux tab whose window runs Claude Code, started from a shell prompt
- **WHEN** Tabby restarts, the tab is restored, and the user then exits Claude Code
- **THEN** the tab shows the shell's history and screen as they were before Claude Code started, followed by what the shell prints after it exits, with no part of Claude Code's screen left on it

#### Scenario: Restored tab while the program runs
- **WHEN** Tabby restarts with a tomux tab open on a window running a full-screen program, and the tab is restored
- **THEN** the tab shows the program's screen with the cursor where tmux has it, and scrolling up does not show the shell's history while the program runs

#### Scenario: Program exits while the tab is disconnected
- **GIVEN** a tomux tab showing a full-screen program
- **WHEN** the connection drops, the program exits before the tab reconnects, and the tab then reconnects
- **THEN** the tab shows the shell's history and screen, and the shell's later output, on its normal screen

#### Scenario: Active pane changes from a full-screen program to a shell
- **GIVEN** a tomux tab showing a pane that runs a full-screen program
- **WHEN** the window's active pane changes to a pane running a shell
- **THEN** the tab shows the shell pane's history and screen on its normal screen, and scrolling up shows that pane's history

#### Scenario: Active pane changes twice in quick succession
- **WHEN** the window's active pane changes from a shell pane to a pane running a full-screen program and, before the tab has redrawn it, to another shell pane
- **THEN** the tab ends up showing the last pane only, and that pane's later output is not lost

#### Scenario: Pane not in the alternate screen
- **WHEN** a tomux tab adopts a window whose pane is not in the alternate screen
- **THEN** the tab shows the pane's history and screen on its normal screen, as before this change

### Requirement: Redrawn tab takes the pane's cursor visibility and mouse mode
When a tomux tab draws a pane from tmux, the tab's cursor SHALL be shown or hidden as tmux reports it for the pane, and the tab's mouse reporting SHALL be the mode tmux reports for the pane, or off when tmux reports none. Settings a program left on in the tab SHALL NOT carry over to a pane that doesn't have them.

#### Scenario: Restored tab of a program that hides the cursor
- **WHEN** Tabby restarts with a tomux tab on a window running a full-screen program that hides the terminal cursor, and the tab is restored
- **THEN** the tab doesn't show a terminal cursor over Claude Code's screen

#### Scenario: Program with mouse reporting exits while the tab is disconnected
- **GIVEN** a tomux tab showing vim with mouse reporting on
- **WHEN** vim exits while the tab is disconnected, and the tab then reconnects
- **THEN** the shell prompt shows the cursor, and scrolling the mouse wheel scrolls the tab instead of typing escape codes at the prompt

#### Scenario: Restored tab of a program with mouse reporting
- **WHEN** Tabby restarts with a tomux tab on a window running a program with mouse reporting on, and the tab is restored
- **THEN** the program receives mouse clicks in the tab

### Requirement: Tab size drives the tmux window size
tomux SHALL tell tmux the tab's size in columns and rows when the tab is created and whenever it changes, coalescing rapid changes, so that programs in the pane draw for the visible size.

#### Scenario: Resizing the Tabby window
- **WHEN** the user drags the Tabby window edge continuously for two seconds
- **THEN** tmux receives the final size shortly after the drag stops, and the pane redraws to fit the tab

### Requirement: Tab title follows the tmux window name
A tomux tab's title SHALL show its tmux window's name when the window has a name of its own, and otherwise the title the program in the window's pane has set or, without one, its placeholder name. A window name of the form `tmux:<digits>` is a placeholder and counts as no name of its own, even when the window was renumbered since; the tab shows it as tmux has it, and shows `tmux:<window index>` when no name is known. A rename made in tmux SHALL update the tab, and a rename made in Tabby SHALL rename the tmux window, without the two sides undoing each other's renames.

#### Scenario: Rename in tmux
- **WHEN** the window is renamed from inside tmux to `logs`
- **THEN** the tab title becomes `logs`

#### Scenario: Rename in Tabby
- **WHEN** the user renames the tab in Tabby to `api`
- **THEN** the tmux window is renamed to `api` and the tab title stays `api`

#### Scenario: Two quick renames
- **WHEN** the window is renamed twice in quick succession on a slow connection
- **THEN** the tab ends on the second name and never shows the first name after the second

#### Scenario: User name wins over the program's title
- **GIVEN** the window is named `api`
- **WHEN** the program in the pane sets the title `fix login bug`
- **THEN** the tab title stays `api`

#### Scenario: Rename in Tabby to the shown program title
- **GIVEN** the window is unnamed and the tab shows the program's title `fix login bug`
- **WHEN** the user renames the tab in Tabby to `fix login bug`
- **THEN** the tmux window is renamed to `fix login bug` and later program titles no longer change the tab

#### Scenario: Rename back to the placeholder
- **GIVEN** the window is named `api` and the program has set the title `fix login bug`
- **WHEN** the user renames the tab in Tabby to `tmux:3`
- **THEN** the tmux window is renamed to `tmux:3` and the tab title becomes `fix login bug`

### Requirement: Tab shows the program's title while the window is unnamed
While a tomux tab's window has no name of its own, the tab SHALL show the most recent non-empty title the program in the window's active pane set with OSC 0 or OSC 2, as a local Tabby tab does. An empty title SHALL return the tab to the window's placeholder name.

#### Scenario: Claude Code names the tab
- **GIVEN** the window is unnamed and the tab shows `tmux:2`
- **WHEN** a program in the pane writes `ESC ] 0 ; fix login bug BEL`
- **THEN** the tab title becomes `fix login bug`

#### Scenario: Title updates follow the program
- **WHEN** the program sets the title to `a`, then `b`, then `c`
- **THEN** the tab ends on `c`

#### Scenario: Program clears its title
- **GIVEN** the tab shows the program's title
- **WHEN** the program sets an empty title
- **THEN** the tab title becomes the window's placeholder name, `tmux:<n>`

#### Scenario: Window gets a name later
- **GIVEN** the tab shows the program's title `fix login bug`
- **WHEN** the window is renamed from inside tmux to `logs`
- **THEN** the tab title becomes `logs`

### Requirement: Program titles stay in Tabby
tomux SHALL NOT rename the tmux window, or change any other tmux option, because a program set a title. Program titles SHALL NOT send any command to tmux.

#### Scenario: Frequent title changes
- **WHEN** a program sets a new title many times per second
- **THEN** the tab follows the titles, the tmux window name is unchanged and tomux sends no tmux command for them

### Requirement: Program title survives reattach and pane switches
When a tomux tab attaches to its window (new tab, restore, reconnect) or the window's active pane changes inside tmux, the tab SHALL take the program's title from the title tmux holds for the active pane, unless that title is tmux's default for a pane no program has titled (the host name), or is a Kitty graphics command that tmux stored as the title (an APC sequence such as a graphics support query). In both cases the tab SHALL show what it shows for a pane with no title.

#### Scenario: Reconnect keeps the title
- **GIVEN** Claude Code set the title `fix login bug` in an unnamed window
- **WHEN** the connection drops and the tab reconnects
- **THEN** the tab title is `fix login bug` without the program setting it again

#### Scenario: Pane never titled
- **GIVEN** no program in the active pane has set a title
- **WHEN** the tab attaches to the unnamed window
- **THEN** the tab title is the window's placeholder name, `tmux:<n>`, not the host name

#### Scenario: Pane switch inside tmux
- **GIVEN** an unnamed window whose two panes have titles `build` and `editor`, and the tab shows `build`
- **WHEN** the active pane changes inside tmux to the `editor` pane
- **THEN** the tab title becomes `editor`

#### Scenario: Graphics query replaced the pane's title
- **GIVEN** a program in an unnamed window set the title `fix login bug`, then wrote the Kitty graphics query `ESC _ Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC \`, so tmux holds `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA` as the pane's title
- **WHEN** Tabby restarts and the tab is restored, or the tab reconnects
- **THEN** the tab title is the window's placeholder name, `tmux:<n>`, not the query, until the program sets a title again

#### Scenario: Graphics query while the tab is live
- **GIVEN** the tab shows the program's title `fix login bug`
- **WHEN** the program writes a Kitty graphics query
- **THEN** the tab title stays `fix login bug`

### Requirement: Dynamic titles follow the profile toggle
Program titles SHALL be shown unless Tabby's "Disable dynamic tab title" option is set on the tomux profile, in which case the tab title SHALL follow only the tmux window name, as before this change. This SHALL also hold for tabs tomux opens for windows created inside tmux.

#### Scenario: Toggle set
- **GIVEN** the tomux profile has "Disable dynamic tab title" set
- **WHEN** a program in an unnamed window sets a title
- **THEN** the tab title stays the window's placeholder name, `tmux:<n>`

#### Scenario: Window created inside tmux
- **GIVEN** the tomux profile has "Disable dynamic tab title" set
- **WHEN** a window is created from inside tmux and tomux opens a tab for it
- **THEN** that tab ignores program titles too

### Requirement: Closing a tab kills its window
When the user closes a tomux tab (its close button, the close-tab hotkey, or a close action in the tab context menu), tomux SHALL kill the bound tmux window.

#### Scenario: Close one of three tabs
- **WHEN** the user closes one of three tomux tabs
- **THEN** its tmux window no longer exists and the other two windows and tabs are unaffected

### Requirement: Kill only on proof of a user close
tomux SHALL kill a tmux window only when it has positive evidence that the user closed that specific tab, and the tab still holds the window. In every other case in which a tomux tab goes away, including Tabby closing, a crash, a lost connection, or a tab being replaced by another tab for the same window, tomux SHALL leave the window running.

#### Scenario: Closing the Tabby window
- **WHEN** the user closes the Tabby window holding three tomux tabs
- **THEN** all three tmux windows are still running afterwards

#### Scenario: Restart tab
- **WHEN** the user runs Tabby's "Restart tab" on a tomux tab
- **THEN** the tmux window is still running and the restarted tab shows it

#### Scenario: Tabby crashes
- **WHEN** the Tabby process is killed while tomux tabs are open
- **THEN** all tmux windows are still running afterwards

#### Scenario: Closing one pane of a Tabby split
- **GIVEN** the user split a tomux tab with Tabby's split action
- **WHEN** the user closes one pane of that split with the close-pane hotkey or that pane's context menu
- **THEN** that pane's tmux window keeps running and opens as a tab the next time its session connects

### Requirement: Window closed in tmux closes its tab
When the bound tmux window ends (its shell exits, or it is killed from inside tmux or by another client), tomux SHALL close the tab without sending any further command for that window.

#### Scenario: Shell exits
- **WHEN** the user types `exit` in a tomux tab whose session has other windows
- **THEN** that tab closes and the other tabs remain

### Requirement: Tabby tab hotkeys keep working
tomux tabs SHALL behave as ordinary Tabby top-level tabs for Tabby's tab navigation and arrangement hotkeys, such as next tab, previous tab, go to tab N, and move tab left or right.

#### Scenario: Switch tabs by number
- **WHEN** three tomux tabs are open and the user presses Tabby's "go to tab 2" hotkey
- **THEN** the second tab becomes active and receives keyboard input

#### Scenario: Reorder tabs
- **WHEN** the user moves a tomux tab left
- **THEN** the tab moves in Tabby's tab bar and the tmux window numbers are unchanged (the new order is recorded only in `@tomux-order`, see `tmux-tab-recovery`)

### Requirement: A shorter pane scrolls within its rows
When the pane a tomux tab shows is shorter than the tab, the tab SHALL show the pane on its top rows and scroll only those rows, as tmux scrolls the pane. A line that scrolls off the pane's top row SHALL go to the tab's scrollback. The tab's rows below the pane SHALL stay empty. A pane as tall as the tab SHALL behave as before.

#### Scenario: New line on the pane's last row
- **GIVEN** a tab shows an 11-row pane of a window with two panes, in a 25-row tab, and the shell's prompt is on the pane's last row
- **WHEN** the user runs `echo one` and then `echo two`
- **THEN** the tab's top 11 rows are the same as tmux's capture of the pane, the cursor is where tmux has it, and the tab's rows 12 to 25 are empty
- **AND** the lines that scrolled off the pane's top row are in the tab's scrollback, in order

#### Scenario: Pane border status line
- **GIVEN** tmux draws a status line in the pane borders (`pane-border-status top` or `bottom`), and a tab shows a pane of a window with two panes
- **WHEN** a command prints more lines than the pane has rows
- **THEN** the tab scrolls within the pane's rows, without the status line's row, matching tmux's capture of the pane

#### Scenario: Window with one pane
- **WHEN** a tab shows a window with one pane and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row and keeps every line in its scrollback, as before this change

### Requirement: A shorter pane keeps its rows when programs and resizes reset them
A tab showing a pane shorter than itself SHALL keep scrolling within the pane's rows after anything that would otherwise give the scrolling back to the whole tab: a program setting or resetting its own scroll region, a program entering or leaving the alternate screen, a terminal reset, and a resize of the tab. A program's own scroll region inside the pane SHALL still apply as the program set it.

#### Scenario: Program resets its scroll region
- **GIVEN** a tab shows an 11-row pane in a 25-row tab
- **WHEN** a program in the pane sets a scroll region of rows 2 to 5, scrolls in it, then resets the scroll region and prints lines until the pane scrolls
- **THEN** the region of rows 2 to 5 scrolls as the program set it, and after the reset the tab scrolls within the pane's 11 rows, matching tmux's capture of the pane

#### Scenario: Full-screen program in a short pane
- **GIVEN** a tab shows an 11-row pane in a 25-row tab
- **WHEN** a program enters the alternate screen, prints more lines than the pane has rows, and exits
- **THEN** while it runs and after it exits, the tab's top 11 rows and its cursor are the same as tmux's, and the rows below the pane are empty

#### Scenario: Tab resized
- **GIVEN** a tab shows a pane shorter than the tab
- **WHEN** the user resizes the Tabby window and then a command prints more lines than the pane has rows
- **THEN** the tab scrolls within the pane's rows at the pane's new height, matching tmux's capture of the pane

### Requirement: A shorter pane's rows follow its height
The rows a tab scrolls SHALL follow the shown pane's height in tmux: when the window's layout changes (a pane is added, closed, resized or zoomed) and when the window's active pane changes to a pane of another height. When the height of a pane shorter than its window changes, the tab SHALL show the pane's lines and cursor as tmux has them after the change, before the pane's next output.

#### Scenario: Other pane closed
- **GIVEN** a tab shows an 11-row pane of a window with two panes, in a 25-row tab
- **WHEN** the other pane is closed in tmux, so the shown pane becomes 25 rows tall, and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row, matching tmux's capture of the pane

#### Scenario: Pane zoomed
- **GIVEN** a tab shows an 11-row pane of a window with two panes
- **WHEN** the pane is zoomed in tmux and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row; when the pane is unzoomed, the tab's top rows and cursor are the same as tmux's capture of the pane, and new output scrolls within the pane's rows again

#### Scenario: Tab made shorter
- **GIVEN** a tab shows an 11-row pane of a window with two panes, with the cursor on the pane's last row
- **WHEN** the user makes the Tabby window shorter, so the pane becomes 8 rows tall
- **THEN** the tab's top 8 rows and its cursor are the same as tmux's capture of the pane, the rows below are empty, and new output scrolls within the 8 rows

#### Scenario: Active pane changes to a pane of another height
- **GIVEN** a window has a 7-row pane and a 17-row pane, and the tab shows the 7-row pane
- **WHEN** the 17-row pane becomes active and a command in it prints more lines than it has rows
- **THEN** the tab shows the 17-row pane on its top 17 rows and scrolls within them, matching tmux's capture of the pane
