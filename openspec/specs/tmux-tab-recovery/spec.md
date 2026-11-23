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
