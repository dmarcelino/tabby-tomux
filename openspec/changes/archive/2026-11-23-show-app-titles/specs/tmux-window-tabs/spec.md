# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
