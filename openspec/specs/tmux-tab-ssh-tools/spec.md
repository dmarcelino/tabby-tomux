# tmux-tab-ssh-tools Specification

## Purpose

Gives a tomux tab the same SSH tools as a Tabby SSH tab (toolbar, SFTP browser, port forwarding, reconnect) and reports the tmux pane's working directory to Tabby, so moving from SSH tabs to tomux tabs loses nothing.

## Requirements

### Requirement: Toolbar like an SSH tab
A tomux tab SHALL show Tabby's terminal toolbar, which appears and can be pinned or unpinned as in other terminal tabs. The toolbar SHALL offer Reconnect, SFTP and Ports, each shown under the same conditions as in a Tabby SSH tab: Reconnect always, SFTP while the tab's session is open, and Ports while the session is open and Tabby is not running as the web app.

#### Scenario: Connected tab
- **WHEN** the user reveals the toolbar of a connected tomux tab in the Tabby desktop app
- **THEN** the toolbar shows Reconnect, SFTP and Ports buttons

#### Scenario: Disconnected tab
- **WHEN** the user reveals the toolbar of a tomux tab whose connection was lost
- **THEN** the toolbar shows Reconnect and does not show SFTP or Ports

#### Scenario: Pinning
- **WHEN** the user pins the toolbar of a tomux tab
- **THEN** the toolbar stays visible, and Unpin hides it again as in other terminal tabs

### Requirement: Toolbar label names host and session
The toolbar label of a tomux tab SHALL show the SSH profile's user, host and port in the same `user@host:port` form as an SSH tab, followed by the tmux session name.

#### Scenario: Label
- **WHEN** a tomux tab uses an SSH profile with user `dev`, host `build1`, port `22` and tmux session `main`
- **THEN** the toolbar label shows `dev@build1:22` and `main`

### Requirement: SFTP panel on the tab's SSH connection
SFTP SHALL open Tabby's SFTP panel inside the tab, browsing the host over the SSH connection the tab already uses, with no new login. Tabby's "Open SFTP panel" tab menu item and its open-SFTP hotkey SHALL open the same panel on a tomux tab.

#### Scenario: Open from the toolbar
- **WHEN** the user clicks SFTP in a connected tomux tab
- **THEN** Tabby's SFTP panel opens in that tab and lists the remote folder without asking for credentials again

#### Scenario: Open from the tab menu or hotkey
- **WHEN** the user chooses "Open SFTP panel" from a connected tomux tab's context menu, or presses Tabby's open-SFTP hotkey in it
- **THEN** the same SFTP panel opens in that tab

#### Scenario: Close the panel
- **WHEN** the user closes the SFTP panel or clicks the terminal area
- **THEN** the panel closes and the tmux window is shown and usable as before

#### Scenario: tmux window unaffected
- **WHEN** the user browses, uploads or downloads files in the SFTP panel
- **THEN** nothing is typed into the tmux window and the window keeps running

### Requirement: SFTP opens at the pane's current folder
When the SFTP panel opens, it SHALL start in the current working directory of the tmux pane the tab shows. If tmux cannot report it, the panel SHALL start where Tabby's SFTP panel starts in an SSH tab without working directory detection.

#### Scenario: Shell changed directory
- **WHEN** the user runs `cd /var/log` in a tomux tab and then opens SFTP
- **THEN** the SFTP panel starts in `/var/log`

#### Scenario: Working directory unknown
- **WHEN** tmux reports no current path for the pane and the user opens SFTP
- **THEN** the SFTP panel opens at its default starting folder

### Requirement: Pane working directory reported to Tabby
A tomux tab SHALL report its tmux pane's current working directory to Tabby, so Tabby's features that use it work on tomux tabs, and Tabby's tips about setting up working directory detection are not shown for tomux tabs.

#### Scenario: Copy current path
- **WHEN** the user opens the context menu of a connected tomux tab whose shell is in `/srv/app`
- **THEN** the menu offers "Copy current path", and choosing it copies `/srv/app`

#### Scenario: No detection tip
- **WHEN** the user reveals the toolbar or opens the SFTP panel in a connected tomux tab
- **THEN** no tip about setting up working directory detection is shown

### Requirement: Port forwarding on the shared SSH connection
Ports SHALL open Tabby's port forwarding dialog for the SSH connection the tab uses. Forwards added or removed there SHALL apply to that SSH connection, so every tab sharing it sees the same forwards, and they SHALL last as long as that connection stays open.

#### Scenario: Add a forward
- **WHEN** the user adds a local forward from port 8080 to `localhost:80` in a tomux tab's Ports dialog
- **THEN** connections to local port 8080 reach port 80 on the host

#### Scenario: Shared between tabs
- **WHEN** the user adds a forward from one tomux tab and opens Ports in another tomux tab of the same host and session
- **THEN** the second tab's dialog lists that forward

#### Scenario: Profile forwards
- **WHEN** the SSH profile a tomux profile uses has forwarded ports configured
- **THEN** those forwards are active while the tomux tabs are connected and listed in the Ports dialog

### Requirement: Reconnect re-attaches the tab's window
Reconnect SHALL run the tab's connect flow again and show the same tmux window. It SHALL NOT kill or create tmux windows, and SHALL NOT disconnect other tabs that share the connection.

#### Scenario: Reconnect while connected
- **WHEN** the user clicks Reconnect in a connected tomux tab
- **THEN** the tab shows the same tmux window again, redrawn from tmux with its history, and other tomux tabs of the session keep working without interruption

#### Scenario: Reconnect after a dropped connection
- **WHEN** the connection dropped and the user clicks Reconnect
- **THEN** tomux connects again (asking for credentials if Tabby needs them) and the tab shows the same tmux window

#### Scenario: Window gone
- **WHEN** the tab's tmux window was closed while the tab was disconnected and the user clicks Reconnect
- **THEN** the tab closes without creating a new tmux window
