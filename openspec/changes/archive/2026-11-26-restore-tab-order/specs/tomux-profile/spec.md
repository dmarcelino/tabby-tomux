# Spec Delta

## MODIFIED Requirements

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
