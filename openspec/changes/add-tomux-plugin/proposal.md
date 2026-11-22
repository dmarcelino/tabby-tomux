# Proposal

## Why

No terminal on Windows maps tmux windows to native tabs the way iTerm2's `tmux -CC` integration does: Windows Terminal's control-mode PRs are unmerged and unlikely to land before 2027, WezTerm competes with tmux, and the existing Tabby plugin (tabby-tmux) deliberately renders tmux windows in its own bottom bar instead of Tabby's tabs. tmux-integrated (a VS Code extension) shows that the iTerm2 model works reliably when it is kept to one pane per window; tomux brings that model to Tabby as a plugin, so users keep Tabby's tabs, hotkeys and SSH handling while tmux keeps their work alive on the server.

## What Changes

- New Tabby plugin **tomux**, hosted at `dmarcelino/tabby-tomux`, licensed **GPL-3.0-only** so it can port code from tmux-integrated (GPL-3.0-only).
- Each tmux window of a remote session is shown as one native Tabby top-level tab, with exactly one pane per window. tmux splits are not supported.
- One tmux control-mode connection (`tmux -CC new-session -A -s <name>`) per host and session, carried over Tabby's own SSH connection for that host and shared by all of that session's tabs.
- A new **tomux profile type** that points at an existing Tabby SSH profile plus a tmux session name. Setting a tomux profile as Tabby's default profile makes `+` and the new-tab hotkey create a new tmux window on that fixed host.
- Closing a tomux tab kills its tmux window. Closing Tabby, a crash, a dropped connection or "restart tab" only detaches; tmux windows keep running.
- Reopening Tabby restores the main window's tomux tabs by re-attaching each one to its tmux window by id, and opens any tmux windows that no tab claimed as extra tabs.
- Tabby's existing tab hotkeys (next/previous tab, tab N, move tab) work on tomux tabs unchanged.
- tmux is assumed to be installed on the remote host; tomux does not install it.
- The first implementation tasks are three spikes that validate the riskiest assumptions against Tabby's code before the feature is built.

Out of scope for this change: tmux splits/panes, syncing Tabby tab order back to tmux, a `+` that follows the active tab's host, restoring tabs of secondary Tabby windows, a confirmation prompt before killing a window, installing tmux, and local (non-SSH) tmux.

## Capabilities

### New Capabilities
- `tmux-control-connection`: Establishing, sharing, health-checking and tearing down the tmux control-mode connection over a Tabby SSH session, including the control-mode protocol (command queue, notifications, output decoding).
- `tmux-window-tabs`: The 1:1 mapping between tmux windows and native Tabby tabs: creating and adopting windows, input and output, resizing, titles and rename sync, and what closing a tab or a tmux window does to the other side.
- `tmux-tab-recovery`: Restoring tomux tabs after Tabby restarts, and the related Tabby flows that re-create tabs from recovery tokens (duplicate, restart, reopen closed tab).
- `tomux-profile`: The tomux profile type, its settings (SSH profile, tmux session name), and how it drives Tabby's `+` button and new-tab hotkey.

### Modified Capabilities
<!-- None: this is a new project with no existing specs. -->

## Impact

- **New code**: the whole plugin in this repository (Angular module, profile provider, tab component, session, control connection, recovery provider), built with webpack as a Tabby plugin package (`keywords: ["tabby-plugin"]`), following the build setup tabby-tmux uses.
- **Ported code (GPL-3.0-only)**: tmux-integrated's protocol gateway (`tmuxGateway.ts`), title and rename-sync logic (`windowTitle.ts`), typed tmux commands from `tmuxControlClient.ts`, and its `send-keys` input encoding. Attribution and the GPL-3.0 license text are added to this repository.
- **Tabby dependencies**: `tabby-core`, `tabby-terminal` and `tabby-ssh` public exports (`ProfileProvider`, `TabRecoveryProvider`, `BaseSession`, `SSHMultiplexerService`, `SSHTabComponent`) plus some APIs Tabby marks `@hidden` (`SSHTabComponent` internals, `SSHSession` instance members). Tabby updates may break these; the spikes confirm what is needed.
- **Possible upstream contribution to Tabby**: `SplitTabComponent.destroy()` drops its `skipDestroyedEvent` argument, so closing the Tabby window looks like closing every tab. tomux works around this; a one-line fix could be offered upstream.
- **Remote hosts**: require tmux with control mode and `refresh-client -C` (tmux 2.1 or newer; newer recommended).
