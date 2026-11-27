# Proposal

## Why

Tabby's SSH tabs have a toolbar with Reconnect, SFTP and Ports buttons, and users rely on it. tomux tabs are SSH tabs underneath (they extend `SSHTabComponent` and share the host's SSH connection), but `add-tomux-plugin` design D3 left the toolbar out, so tomux users lose the SFTP browser and port forwarding. There is also a bug: Tabby's "Open SFTP panel" item in the tab menu and the `open-sftp` hotkey both appear on tomux tabs but do nothing.

## What Changes

- tomux tabs show Tabby's terminal toolbar (`terminal-toolbar`, which includes Pin/Unpin) with the same buttons as an SSH tab: Reconnect, SFTP and Ports, shown under the same conditions as in SSH tabs.
- The toolbar label shows `user@host:port` as in SSH tabs, followed by the tmux session name.
- SFTP opens Tabby's own SFTP panel on the tab's SSH connection. The tab menu's "Open SFTP panel" item and the `open-sftp` hotkey open the same panel, so they stop doing nothing.
- Ports opens Tabby's own port forwarding dialog for the tab's SSH connection. Forwards belong to that connection, so every tab that uses it (tomux or plain SSH) shares them.
- Reconnect works as in SSH tabs: it runs the tab's connect flow again. While the connection is healthy this re-attaches the same tmux window and redraws it from tmux. While the connection is down it reconnects.
- tomux tabs report the working directory of their tmux pane (tmux's `#{pane_current_path}`). As a result the SFTP panel opens in the shell's current folder, Tabby's "set up working directory detection" tips are hidden, and Tabby's "Copy current path" item appears in the tab menu.
- This partly reverses `add-tomux-plugin` design D3 ("the SSH toolbar is simply absent"); this change's design records the new decision.

Out of scope: WinSCP launching beyond what Tabby already offers on SSH tabs, any SFTP or port forwarding features Tabby doesn't have, and "Save as profile" on a tomux tab (it saves an SSH profile instead of a tomux profile; that is a separate issue).

## Capabilities

### New Capabilities
- `tmux-tab-ssh-tools`: The SSH tools a tomux tab offers on top of its tmux window: the toolbar and its label, the SFTP panel, port forwarding, Reconnect, and reporting the pane's working directory to Tabby.

### Modified Capabilities
<!-- None. The related capabilities (tmux-window-tabs, tmux-control-connection) exist only in the unarchived add-tomux-plugin change, and no requirement in them changes. -->

## Impact

- **Code**: `src/components/tomuxTab.component.ts` (template, toolbar label, hosting the SFTP panel), `src/paneSession.ts` (working directory), `src/tmux/controlClient.ts` (a typed query for the pane's current path), `src/tabbyAdapter.ts` (access to tabby-ssh's `SFTPPanelComponent` and creating it in code).
- **Tabby internals**: tabby-ssh doesn't export the `sftp-panel` element to other modules, so tomux creates `SFTPPanelComponent` in code. This depends on tabby-ssh's runtime exports and on `SSHTabComponent` members `openSFTP()`, `showPortForwarding()`, `sftpPanelVisible`, `sftpPath` and `onClick()`, which are `@hidden`. A spike checks this in a running Tabby first.
- **Depends on**: `add-tomux-plugin` (the tomux tab, its session and the control client).
- **Docs**: README (toolbar, SFTP, shared port forwards), `doc/TESTING.md` (manual checks against a real tmux).
- **No new dependencies.**
