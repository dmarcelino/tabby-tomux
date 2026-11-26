# Spec Delta

## ADDED Requirements

### Requirement: Tab order is recorded in tmux
tomux SHALL store each bound window's tab position among its session's tomux tabs in the main Tabby window in the window's tmux user option `@tomux-order` (0 for the leftmost), and SHALL update it within 5 seconds after those tabs are dragged, opened or closed, and within 15 seconds after they are moved with Tabby's move-tab hotkeys. Recording the order SHALL NOT change tmux window numbers. Tabs in other Tabby windows SHALL NOT write it.

#### Scenario: Drag a tab
- **GIVEN** the main Tabby window has tomux tabs for windows `@1`, `@2` and `@3` of session `main`, in that order
- **WHEN** the user drags the tab for `@3` to the far left
- **THEN** within 5 seconds `@tomux-order` reads `1` for `@1`, `2` for `@2` and `0` for `@3`, and the windows' numbers in tmux are unchanged

#### Scenario: Move a tab with the hotkey
- **GIVEN** the main Tabby window has tomux tabs for `@1` and `@2` of session `main`, in that order
- **WHEN** the user selects the tab for `@2` and presses Tabby's "move tab left" hotkey
- **THEN** within 15 seconds `@tomux-order` reads `0` for `@2` and `1` for `@1`

#### Scenario: Tabs of other sessions do not count
- **GIVEN** the main Tabby window shows, from left to right, a tab for `@2` of session `main` and a tab for session `other`
- **WHEN** the user opens a tab for window `@1` of session `main` at the right end of the tab bar
- **THEN** within 5 seconds `@tomux-order` reads `0` for `@2` and `1` for `@1`

#### Scenario: Second Tabby window
- **WHEN** the user reorders tomux tabs in a second Tabby window
- **THEN** no window's `@tomux-order` changes

### Requirement: Recorded order survives startup
tomux SHALL NOT change any window's `@tomux-order` for a session until it has opened tabs for that session's unclaimed windows after connecting.

#### Scenario: Tab restore off
- **GIVEN** session `main` has windows `@1`, `@2` and `@3` with `@tomux-order` `2`, `0` and `1`, and Tabby's tab restore is turned off
- **WHEN** Tabby starts and the user opens the profile for `main`
- **THEN** no window's `@tomux-order` changes before tomux has opened tabs for all three windows

### Requirement: Unclaimed windows open in recorded order
When tomux opens tabs for a session's unclaimed windows after connecting, it SHALL add them to the tab bar in ascending `@tomux-order`, with ties in window-number order. Windows without a whole-number `@tomux-order` SHALL come after those, in window-number order. The order SHALL NOT depend on how long each tab takes to prepare.

#### Scenario: Order restored without Tabby's saved tabs
- **GIVEN** session `main` has windows `@1`, `@2` and `@3` with `@tomux-order` `2`, `0` and `1`, and Tabby has no saved tabs for it
- **WHEN** the user opens the profile for `main`
- **THEN** the tabs appear in the order `@2`, `@3`, `@1`

#### Scenario: Windows created while Tabby was closed
- **GIVEN** Tabby restores tabs for `@1` and `@2` of session `main`, and windows `@5` (number 4) and `@4` (number 6) were created on the host while Tabby was closed, with no `@tomux-order`
- **WHEN** `main` connects
- **THEN** the tabs for `@5` and `@4` open after the restored tabs, `@5` first

#### Scenario: tmux without the option
- **GIVEN** the host's tmux does not report `@tomux-order`
- **WHEN** tomux opens tabs for unclaimed windows
- **THEN** they open in window-number order
