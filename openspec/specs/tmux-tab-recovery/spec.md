# tmux-tab-recovery Specification

## Purpose

Brings tomux tabs back after Tabby restarts, each bound to the same tmux window it showed before, and defines how Tabby's other tab re-creation actions (duplicate, restart, reopen closed tab) map onto tmux windows.

## Requirements

### Requirement: Restore tabs after Tabby restarts
When Tabby restores tabs at startup, each saved tomux tab of the main Tabby window SHALL reconnect to its host and session and bind to the same tmux window it showed before, keeping its tab position.

#### Scenario: Close and reopen Tabby
- **GIVEN** the main Tabby window has three tomux tabs bound to tmux windows `@1`, `@2` and `@3` of session `main`
- **WHEN** the user closes Tabby and opens it again
- **THEN** Tabby shows three tomux tabs in the same order, bound to `@1`, `@2` and `@3`, each showing its window's scrollback and screen

#### Scenario: Restore needs a password
- **WHEN** Tabby restores several tomux tabs whose SSH profile needs a password
- **THEN** the user is asked for the password once, and all restored tabs connect after it is entered

### Requirement: Restored window no longer exists
If a saved tomux tab's tmux window no longer exists when Tabby restores it, tomux SHALL close that tab instead of creating a replacement window.

#### Scenario: Window killed while Tabby was closed
- **GIVEN** a saved tomux tab was bound to window `@2`
- **WHEN** `@2` was killed on the host before Tabby restarted
- **THEN** that tab does not appear after restore and no new tmux window is created for it

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

### Requirement: Unclaimed windows open as extra tabs
After a connection's restored tabs have bound their windows, tomux SHALL open one new tomux tab for each remaining window of the session that no tab is bound to.

#### Scenario: Window created from another machine
- **GIVEN** Tabby was closed with two tomux tabs for session `main`
- **WHEN** a third window was created in `main` from another machine, and Tabby is reopened
- **THEN** Tabby shows the two restored tabs plus one extra tab for the third window, and no window is shown twice

### Requirement: Restore does not create stray windows
Restoring tomux tabs SHALL NOT create new tmux windows, except that a session which did not exist yet is created with its single initial window.

#### Scenario: Restore with many tabs
- **WHEN** Tabby restores eight tomux tabs of an existing session
- **THEN** the session has the same number of windows after restore as before

### Requirement: Scope of restore
Restoring tomux tabs SHALL be limited to the tabs Tabby itself restores, which is the main Tabby window only. Windows that belonged to tabs of other Tabby windows SHALL remain running and SHALL appear as unclaimed windows the next time their session connects.

#### Scenario: Second Tabby window
- **GIVEN** a second Tabby window had a tomux tab for window `@4` of session `main`
- **WHEN** Tabby is closed and reopened
- **THEN** window `@4` is still running on the host and appears as an extra tab in the main window when `main` connects

### Requirement: Duplicate tab creates a new window
When the user duplicates a tomux tab, the new tab SHALL be bound to a new tmux window in the same session.

#### Scenario: Duplicate
- **WHEN** the user duplicates a tomux tab bound to `@1`
- **THEN** a new tab opens bound to a newly created window, and `@1` stays bound to the original tab

### Requirement: Reopen a closed tab
When the user reopens a recently closed tomux tab, tomux SHALL bind it to its previous tmux window if that window still exists and no tab holds it, and otherwise SHALL bind it to a new tmux window in the same session.

#### Scenario: Reopen after closing
- **WHEN** the user closes a tomux tab, which kills its window, and then reopens the last closed tab
- **THEN** a tab opens bound to a new tmux window in the same session

### Requirement: Restart tab keeps the window
When the user restarts a tomux tab, the restarted tab SHALL be bound to the same tmux window, and the window SHALL keep running throughout.

#### Scenario: Restart
- **WHEN** the user restarts a tomux tab bound to `@3`
- **THEN** the new tab is bound to `@3` and `@3` was never killed

### Requirement: No duplicated screen content on restore
A restored tomux tab SHALL show its window's content as reported by tmux only, without also replaying screen content Tabby saved locally.

#### Scenario: Restored tab content
- **WHEN** a tomux tab is restored
- **THEN** its scrollback contains the window's history once, not twice

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
