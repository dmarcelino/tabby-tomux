# Spec Delta

## ADDED Requirements

### Requirement: Tabs tomux opens for a session's windows look like their profile
When tomux opens a tab on its own for a window of a session, such as the session's other windows when the profile is opened or a window created later from inside tmux or by another client, the tab SHALL show the colour and icon of its tomux profile and, until tmux reports the window's name, the profile's name, as a tab opened from that profile would. Tabs Tabby restores keep the colour and icon saved with them.

#### Scenario: Opening the profile on a session with several windows
- **GIVEN** the tomux profile `work-server` has a red tab colour and an icon, and its session has windows `@1` and `@2` with no tomux tab connected to it
- **WHEN** the user opens `work-server`
- **THEN** the tab bound to `@1` and the extra tab opened for `@2` are both red and both have `work-server`'s icon

#### Scenario: Window created inside tmux
- **GIVEN** the tomux profile `work-server` has a red tab colour and tabs for its session are open
- **WHEN** a window is created in the session from inside tmux
- **THEN** the tab that opens for it is red and, until tmux reports the window's name, shows the title `work-server`

#### Scenario: Profile without a colour
- **GIVEN** the tomux profile `build-box` has no tab colour and no icon, and its session has two windows with no tomux tab connected to it
- **WHEN** the user opens `build-box`
- **THEN** neither tab has a tab colour or an icon

#### Scenario: Restored tab keeps the colour picked for it
- **GIVEN** the tomux profile `work-server` has a red tab colour, and the user set one of its tabs to green from the tab menu
- **WHEN** Tabby restarts and restores the tabs
- **THEN** that tab is still green
