# tomux-profile Specification

## Purpose

Defines the tomux profile type users create in Tabby's profile settings, which names the SSH host and tmux session to use and lets Tabby's `+` button and new-tab hotkey open new tmux windows.

## Requirements

### Requirement: tomux profile type
tomux SHALL add a profile type to Tabby's profile manager. A tomux profile SHALL reference one existing Tabby SSH profile and a tmux session name, with `main` as the default session name.

#### Scenario: Create a tomux profile
- **WHEN** the user creates a new profile in Tabby and chooses the tomux type
- **THEN** the editor lets them pick one of their SSH profiles and enter a tmux session name, prefilled with `main`

#### Scenario: Profile appears in the profile selector
- **WHEN** the user opens Tabby's profile selector
- **THEN** each saved tomux profile is listed and opening it opens a tomux tab for its host and session

### Requirement: Opening a tomux profile opens a new window
When the profile's session is already connected, opening the profile SHALL open a tab bound to a new tmux window. When it is not, tomux SHALL connect and bind the tab to an existing window instead of creating one: the session's initial window if the connection created the session, otherwise the first of its windows in recorded tab order (lowest `@tomux-order`, then lowest number, as for unclaimed windows in `tmux-tab-recovery`), with the remaining windows opened as extra tabs.

#### Scenario: Session already connected
- **WHEN** tabs for the profile's session are open and the user opens the profile again
- **THEN** a new tab opens bound to a new tmux window

#### Scenario: First open creates the session
- **WHEN** the profile's session does not exist and the user opens the profile
- **THEN** one tab opens bound to the new session's only window, and the session has exactly one window

#### Scenario: First open attaches to an existing session
- **WHEN** the profile's session exists with two windows that have no `@tomux-order`, and no tomux tab is connected to it
- **THEN** one tab opens bound to the lowest-numbered window, one extra tab opens for the other window, and no new tmux window is created

#### Scenario: First open follows the recorded order
- **GIVEN** the profile's session has windows `@1` and `@2` with `@tomux-order` `1` and `0`, and no tomux tab is connected to it
- **WHEN** the user opens the profile
- **THEN** the tab binds to `@2`, one extra tab opens for `@1` to its right, and no new tmux window is created

### Requirement: Plus button and new-tab hotkey
When a tomux profile is set as Tabby's default profile, Tabby's `+` button and new-tab hotkey SHALL open a tomux tab bound to a new tmux window. If the active tab, or the focused pane of a split, is a tomux tab whose profiles still exist and that shows no profile or session-name error, the window SHALL be created in that tab's host and session, whatever its connection state. Otherwise it SHALL be created in the default profile's host and session.

#### Scenario: Plus with a tomux default profile
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and tabs for its session are open
- **WHEN** the user clicks `+` while a non-tomux tab is active
- **THEN** a new tab opens bound to a new tmux window on `work-server`'s session

#### Scenario: Plus follows the active tomux tab
- **GIVEN** the tomux profile `work-server` is Tabby's default profile
- **AND** the active tab is a tomux tab of the profile `build-box`, session `ci`
- **WHEN** the user clicks `+`
- **THEN** a new tab opens bound to a new tmux window in session `ci` on `build-box`'s host, and no tab opens for `work-server`'s session

#### Scenario: Plus in a second Tabby window
- **GIVEN** the tomux profile `work-server` is Tabby's default profile, the first Tabby window shows the windows of its session, and a second Tabby window shows only tabs of session `ci`
- **WHEN** the user clicks `+` in the second Tabby window while one of its `ci` tabs is active
- **THEN** exactly one tab opens in the second Tabby window, bound to a new tmux window in `ci`, and no tab opens there for `work-server`'s windows

#### Scenario: Focused pane of a split
- **GIVEN** the active tab is a Tabby split whose focused pane is a tomux tab of session `ci`
- **WHEN** the user presses the new-tab hotkey
- **THEN** a new tab opens bound to a new tmux window in `ci`

#### Scenario: Active tab is disconnected
- **GIVEN** the active tab is a tomux tab of session `ci` whose connection was lost
- **WHEN** the user clicks `+`
- **THEN** the new tab opens for session `ci`, not for the default profile's session

#### Scenario: Session the tab is in, not the profile's current setting
- **GIVEN** the active tab was opened for session `ci` and its tomux profile's session name was changed to `ci2` afterwards
- **WHEN** the user clicks `+`
- **THEN** the new tmux window is created in `ci`

#### Scenario: Active tomux tab shows a profile error
- **GIVEN** the active tomux tab shows an error because its SSH profile no longer exists
- **WHEN** the user clicks `+`
- **THEN** the new tab opens on the default profile's session

#### Scenario: Active tab has an invalid session name
- **GIVEN** the active tomux tab shows an error because its session name `a.b` contains a character tmux does not allow
- **WHEN** the user clicks `+`
- **THEN** the new tab opens on the default profile's session

#### Scenario: Active tab's profile was deleted
- **GIVEN** the active tab is a tomux tab of the profile `build-box`, and the user deleted `build-box` (or the SSH profile it uses) after the tab opened
- **WHEN** the user clicks `+`
- **THEN** the new tab opens on the default profile's session

#### Scenario: Choosing another profile from the selector
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and the active tab is a tomux tab of session `ci`
- **WHEN** the user chooses the tomux profile `db-box` in Tabby's profile selector
- **THEN** the new tab opens on `db-box`'s session

#### Scenario: Choosing the default profile from the selector
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and the active tab is a tomux tab of session `ci`
- **WHEN** the user chooses `work-server` in Tabby's profile selector
- **THEN** the new tab opens bound to a new tmux window in `ci`, as with `+`

#### Scenario: Switching a tomux tab to the default profile
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and the focused tab is a tomux tab of session `ci`
- **WHEN** the user uses Tabby's "Switch profile" on that tab and picks `work-server`
- **THEN** the tab is replaced by a tab bound to a new tmux window on `work-server`'s session, not `ci`

### Requirement: Invalid profile reference
If a tomux profile's SSH profile no longer exists, opening the tomux profile SHALL show an error naming the missing SSH profile and SHALL NOT connect anywhere.

#### Scenario: SSH profile deleted
- **WHEN** the user deletes the SSH profile a tomux profile points to, then opens the tomux profile
- **THEN** the tab shows an error naming the missing SSH profile

### Requirement: Session name validation
tomux SHALL accept only tmux session names that tmux can use as-is, and SHALL reject names containing characters tmux does not allow in session names, such as `.` and `:`.

#### Scenario: Invalid session name
- **WHEN** the user enters `my.session` as the session name
- **THEN** the profile editor rejects it and explains which characters are not allowed

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

### Requirement: A tab that follows the active tab looks like its own profile
When `+` or the new-tab hotkey opens a tab in the active tab's session instead of the default profile's, the new tab SHALL show the name, colour and icon of the tomux profile it opened on, as a tab opened from that profile would, and none of the default profile's.

#### Scenario: Default profile has a colour
- **GIVEN** the default tomux profile `work-server` has a red tab colour, the tomux profile `build-box` has no colour, and the active tab is a tomux tab of `build-box`
- **WHEN** the user clicks `+`
- **THEN** the new tab has no tab colour and, until tmux reports its window name, shows the title `build-box`
