# Spec Delta

## Purpose

Connects tomux to a tmux session on a remote host in control mode, over Tabby's own SSH connection, and keeps exactly one healthy control connection per host and session for all of that session's tabs.

## ADDED Requirements

### Requirement: Control connection over Tabby's SSH connection
tomux SHALL reach tmux through the SSH connection Tabby opens for the configured SSH profile, reusing Tabby's authentication, keys, agent, jump hosts and host-key checks. tomux SHALL NOT spawn a local `ssh` process or implement its own SSH client.

#### Scenario: Connect with an SSH profile that uses a password
- **WHEN** the user opens a tomux tab whose SSH profile requires a password or keyboard-interactive answer
- **THEN** Tabby's normal SSH prompt is shown inside that tomux tab
- **AND** after the user answers, the tab connects to tmux without asking again for other tabs of the same session

#### Scenario: Connect with key or agent authentication
- **WHEN** the user opens a tomux tab whose SSH profile authenticates with a key or agent
- **THEN** tomux connects to tmux without showing any prompt

### Requirement: Attach to or create the named tmux session
tomux SHALL start tmux in control mode so that it attaches to the configured session if it exists and creates it if it does not, without the remote shell's prompt, banner or echo reaching the control-mode parser.

#### Scenario: Session already exists
- **WHEN** tomux connects and a tmux session with the configured name is running on the host
- **THEN** tomux attaches to that session and leaves its windows and running processes untouched

#### Scenario: Session does not exist
- **WHEN** tomux connects and no tmux session with the configured name exists
- **THEN** tomux creates the session and the session has exactly one window

#### Scenario: Login banner before tmux starts
- **WHEN** the remote host prints a message of the day or other text before tmux starts
- **THEN** that text is not treated as control-mode protocol and does not appear in any tomux tab

### Requirement: One shared connection per host and session
tomux SHALL keep at most one control connection per SSH host and tmux session name in a Tabby window, shared by all tomux tabs of that session. Concurrent requests for a connection that is still being established SHALL wait for and share that same attempt.

#### Scenario: Several tabs restored at once
- **WHEN** Tabby restores five tomux tabs of the same host and session at startup
- **THEN** tomux opens exactly one control connection and all five tabs use it

#### Scenario: Different sessions on the same host
- **WHEN** the user has tomux tabs for sessions `main` and `work` on the same host
- **THEN** tomux keeps one control connection for each session

### Requirement: Connection health check before reuse
Before reusing an existing control connection for a new tab, tomux SHALL confirm it still responds within a bounded time, and SHALL replace it with a new connection if it does not.

#### Scenario: Stale connection after laptop sleep
- **WHEN** the user opens a new tomux tab after the laptop resumed from sleep and the old control connection no longer responds
- **THEN** tomux discards the stale connection, reconnects, and the new tab works

### Requirement: Detach without killing on shutdown
When tomux stops using a control connection because Tabby is closing, the last tab of the session went away without a kill, or the user disconnects, tomux SHALL detach from tmux and SHALL NOT kill any tmux window or session.

#### Scenario: Tabby window closes
- **WHEN** the user closes the Tabby window that holds tomux tabs
- **THEN** every tmux window of the session is still running on the host afterwards

### Requirement: Connection loss is visible and recoverable
When the control connection or its SSH connection drops unexpectedly, tomux SHALL show every affected tab as disconnected, SHALL NOT kill any tmux window, and SHALL let the user reconnect so each tab re-attaches to its own tmux window.

#### Scenario: Network drop
- **WHEN** the network drops while three tomux tabs are open
- **THEN** all three tabs show that they are disconnected
- **AND** after reconnecting, each tab shows its own tmux window again with its scrollback

### Requirement: tmux session end closes its tabs
When the tmux session ends on the host (for example its last window exits or the session is killed elsewhere), tomux SHALL close the control connection and every tomux tab of that session.

#### Scenario: Last window exits
- **WHEN** the user types `exit` in the only window of a session
- **THEN** that tomux tab closes and the control connection is released

### Requirement: Faithful control-mode protocol handling
tomux SHALL match every command response to the command that produced it, including when several commands are sent in one write, SHALL report command errors to the caller, and SHALL decode pane output as bytes so that UTF-8 characters split across notifications and all escape sequences reach the terminal intact.

#### Scenario: Multi-byte character split across output notifications
- **WHEN** a program prints a multi-byte UTF-8 character whose bytes arrive in two separate output notifications
- **THEN** the character is displayed once and correctly

#### Scenario: Terminal query reply
- **WHEN** a program in the pane sends a cursor-position query and the terminal replies
- **THEN** the reply reaches the program unbroken, with its escape characters preserved

### Requirement: Minimum tmux version
tomux SHALL check the remote tmux version when connecting and SHALL refuse to connect, with a message naming the found and required versions, if it is older than the minimum version tomux supports.

#### Scenario: Old tmux
- **WHEN** the remote host has a tmux version older than the supported minimum
- **THEN** the tomux tab shows an error naming both versions and no control connection is kept open
