# Spec Delta

## MODIFIED Requirements

### Requirement: Plus button and new-tab hotkey
When a tomux profile is set as Tabby's default profile, Tabby's `+` button and new-tab hotkey SHALL open a tomux tab bound to a new tmux window. If the active tab, or the focused pane of a split, is a tomux tab that does not show a profile error, the window SHALL be created in that tab's host and session, whatever its connection state. Otherwise it SHALL be created in the default profile's host and session.

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

#### Scenario: Choosing another profile from the selector
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and the active tab is a tomux tab of session `ci`
- **WHEN** the user chooses the tomux profile `db-box` in Tabby's profile selector
- **THEN** the new tab opens on `db-box`'s session

#### Scenario: Choosing the default profile from the selector
- **GIVEN** the tomux profile `work-server` is Tabby's default profile and the active tab is a tomux tab of session `ci`
- **WHEN** the user chooses `work-server` in Tabby's profile selector
- **THEN** the new tab opens bound to a new tmux window in `ci`, as with `+`

## ADDED Requirements

### Requirement: A tab that follows the active tab looks like its own profile
When `+` or the new-tab hotkey opens a tab in the active tab's session instead of the default profile's, the new tab SHALL show the name, colour and icon of the tomux profile it opened on, as a tab opened from that profile would, and none of the default profile's.

#### Scenario: Default profile has a colour
- **GIVEN** the default tomux profile `work-server` has a red tab colour, the tomux profile `build-box` has no colour, and the active tab is a tomux tab of `build-box`
- **WHEN** the user clicks `+`
- **THEN** the new tab has no tab colour and, until tmux reports its window name, shows the title `build-box`
