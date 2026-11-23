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

### Requirement: Output and scrollback
A tomux tab SHALL show the bound pane's output as it is produced. When a tab binds to a tmux window that already existed, it SHALL first show that pane's existing scrollback and screen and place the cursor where tmux has it.

#### Scenario: Adopting an existing window
- **WHEN** a tomux tab binds to an existing window with 2,000 lines of history
- **THEN** the tab shows that history and the current screen before any new output

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
When a tomux tab attaches to its window (new tab, restore, reconnect) or the window's active pane changes inside tmux, the tab SHALL take the program's title from the title tmux holds for the active pane, unless that title is tmux's default for a pane no program has titled (the host name).

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
- **THEN** the tab moves in Tabby's tab bar and the order of windows in tmux is unchanged
