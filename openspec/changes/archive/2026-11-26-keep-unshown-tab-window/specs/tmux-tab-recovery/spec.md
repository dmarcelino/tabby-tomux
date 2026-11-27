## ADDED Requirements

### Requirement: A tab keeps its window until it is shown
A tomux tab restored or reopened for a tmux window SHALL keep that window when Tabby saves its tabs, even if the tab was never shown and so never connected. On the next start it SHALL be restored for that same window, as a tab bound to it would be.

#### Scenario: Restarted twice without showing the tab
- **GIVEN** the main Tabby window had tomux tabs bound to windows `@1` and `@2` of session `main`, and Tabby was restarted
- **WHEN** the user quits Tabby again without ever selecting the `@2` tab, and starts Tabby once more
- **THEN** Tabby shows two tomux tabs in the same order, and selecting the second one binds it to `@2`
- **AND** no extra tab opens for `@2` and the session has the same windows as before

#### Scenario: Window killed while Tabby was closed, tab never shown
- **GIVEN** a restored tab for window `@2` was never shown before Tabby quit
- **WHEN** `@2` is killed on the host and Tabby starts again
- **THEN** that tab does not appear after restore and no new tmux window is created for it

#### Scenario: Reopen a tab closed before it was shown
- **GIVEN** a restored tab for window `@2` was never shown
- **WHEN** the user closes that tab and then reopens the last closed tab
- **THEN** the reopened tab is bound to `@2`, and no new tmux window is created
