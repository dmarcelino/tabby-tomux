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
When a tomux profile is set as Tabby's default profile, Tabby's `+` button and new-tab hotkey SHALL open a tomux tab bound to a new tmux window on that profile's host and session, whichever tab is active.

#### Scenario: Plus with a tomux default profile
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and tabs for its session are open
- **WHEN** the user clicks `+` while a non-tomux tab is active
- **THEN** a new tab opens bound to a new tmux window on `work-server`'s session

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
