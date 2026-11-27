## MODIFIED Requirements

### Requirement: Tab order is recorded in tmux
tomux SHALL store each bound window's tab position among its session's tomux tabs in the Tabby window that shows its tab in the window's tmux user option `@tomux-order` (0 for the leftmost), and SHALL update it within 5 seconds after those tabs are dragged, opened or closed, and within 15 seconds after they are moved with Tabby's move-tab hotkeys. This SHALL hold in every Tabby window, not only the main one. When tabs for the same session are shown in more than one Tabby window, the value written last SHALL stand. Recording the order SHALL NOT change tmux window numbers.

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
- **GIVEN** a second Tabby window has tomux tabs for windows `@1` and `@2` of session `personal`, in that order, and the main Tabby window has no tab for `personal`
- **WHEN** the user drags the tab for `@2` to the far left in the second Tabby window
- **THEN** within 5 seconds `@tomux-order` reads `0` for `@2` and `1` for `@1`

#### Scenario: Two Tabby windows on one session
- **GIVEN** the main Tabby window and a second Tabby window both have tomux tabs for windows `@1` and `@2` of session `main`, in that order, and `@tomux-order` reads `0` for `@1` and `1` for `@2`
- **WHEN** the user drags the tab for `@2` to the far left in the second Tabby window
- **THEN** within 5 seconds `@tomux-order` reads `0` for `@2` and `1` for `@1`, and it still reads so 15 seconds later although the main Tabby window's tabs are unchanged
