# tomux

A [Tabby](https://github.com/Eugeny/tabby) plugin that uses tmux control mode (`tmux -CC`) so that each tmux window on a remote host is a native Tabby tab, the way iTerm2's tmux integration works.

Status: early development, tested against Tabby 1.0.238 and tmux 3.5a.

## Requirements

- Tabby 1.0.238 or newer.
- A Tabby SSH profile for the host. tomux uses Tabby's own SSH connection, including its logins, keys, jump hosts and host-key checks.
- tmux 2.1 or newer on the host (3.x recommended). tomux does not install tmux.

## Setup

1. In Tabby, open Settings → Profiles & connections → New profile, and choose the template **tomux: tmux session over SSH**.
2. Pick the SSH profile for the host and a tmux session name (default `main`). Session names cannot contain `.` or `:`.
3. Optional: choose this tomux profile under Settings → Profiles & connections → **Default profile for new tabs**. Then `+` and the new-tab hotkey open a new tmux window:
   - When the active tab (or the focused pane of a split) is a tomux tab, the window goes to **that tab's** host and session, even if it belongs to another tomux profile or is reconnecting. The new tab gets that profile's colour and icon.
   - Otherwise, it goes to this profile's host and session.
   - Choosing this profile in the profile selector, with a profile hotkey or from the command line does the same, because Tabby opens it the same way as `+`. Choosing any other profile opens that profile.
   - **New terminal** in a tab's menu also follows the *active* tab, even when you opened the menu on another tab.
   - In a Tabby window with no tab for this profile's session, pressing `+` while a non-tomux tab is active connects that window to the session for the first time, so every window of the session opens as a tab there.

## How it works

- **One tab per tmux window, one pane per tab.** Each tomux tab shows one window of the tmux session. If a window has several tmux panes, the tab shows the active pane and the others keep running.
- **Opening the profile:** if the session doesn't exist, tomux creates it and the tab shows its first window. If it exists, the tab shows the first window in your last tab order, and the session's other windows open as extra tabs in that order (by window number when tomux has no recorded order, for example for windows created while Tabby was closed). Once connected, opening the profile again creates a new window.
- **Windows created elsewhere** (tmux's new-window key, another computer) open as new tabs.
- **Colour and icon:** the extra tabs, and the tabs for windows created elsewhere, get the tomux profile's tab colour and icon, like the tab you opened. Until tmux reports the window's name, they show the profile's name. After a restart, each tab keeps the colour it had, including one you picked from the tab menu. A tab that an older tomux opened without a colour stays that way until you set one from the tab menu.
- **Titles:** a tab shows its tmux window's name. Renaming in tmux renames the tab. Renaming the tab in Tabby renames the tmux window.
  - A window you haven't named is called `tmux:<index>`. Its tab shows the title the program in it sets, as a local terminal tab does. Claude Code, for example, names the tab after its task. tomux never copies that title into tmux.
  - A name you gave the window wins over the program's title. To make the tab follow the program again, rename it to `tmux:<index>`, in Tabby or in tmux.
  - If your shell sets the terminal title at every prompt (many bash and zsh setups do), unnamed tabs show that title, for example `user@host: ~/src`, instead of `tmux:<index>`. To keep `tmux:<index>`, turn on **Disable dynamic tab title** in the tomux profile.
  - After a reconnect, a restart or a pane switch, the tab shows the title tmux remembers for the active pane.
- **Tabby's tab hotkeys** (next/previous tab, go to tab N, move tab) work as usual. Moving a tab doesn't reorder windows in tmux. Instead, tomux records each window's tab position in the tmux window option `@tomux-order` and uses it whenever it opens a session's tabs itself, for example with Tabby's tab restore turned off or on another computer. Each Tabby window records the order of its own tabs whenever they change, including when a tab opens or closes. If two Tabby windows show the same session, the one that recorded last wins. That isn't always the one you reordered in: opening or closing a tmux window changes the tabs in both, and when Tabby starts, the main window records the order of the tabs it restored.
- **Toolbar:** like an SSH tab, a tomux tab has Tabby's toolbar (hover the top of the tab, or pin it). It shows `user@host:port` and the tmux session name, and offers:
  - **SFTP:** opens Tabby's SFTP browser on the same SSH connection, starting in the folder the tab's shell is in (tmux reports it, so no shell setup is needed). The tab's context menu ("Open SFTP panel") and Tabby's SFTP hotkey open it too.
  - **Ports:** Tabby's port forwarding dialog. Forwards belong to the host's SSH connection, so every tab using that connection (all tomux tabs of the host, and SSH tabs sharing the connection) sees the same forwards, and they stay up while any of those tabs is connected. Forwards set in the SSH profile are active as well.
  - **Reconnect:** connects the tab again and shows the same tmux window. While connected, this just redraws the window from tmux; other tabs aren't affected. If the window was closed meanwhile, the tab closes.
- **Copy current path** in the tab's context menu copies the folder the tab's shell is in.

### Closing and restoring

| You do | tmux window |
|---|---|
| Close a tomux tab (× button, close-tab hotkey, tab context menu) | Killed |
| Exit the shell in the tab | Gone; the tab closes |
| Close or quit Tabby, Tabby crashes, the network drops | Keeps running |
| Restart tab | Keeps running; the restarted tab shows it again |
| Duplicate tab, or Tabby's split action | A new window is created |
| Reopen closed tab | A new window, since closing killed the old one |
| Close one pane of a Tabby split (close-pane hotkey or the pane's context menu) | Keeps running, and opens as a tab next time the session connects |

When Tabby starts again, the main Tabby window's tomux tabs come back, each showing the same tmux window with its history. A tab connects when it is first shown, as Tabby's SSH tabs do. Windows that were closed in the meantime don't come back, and windows created in the meantime open as extra tabs. Tabby only restores tabs of its main window. Windows that belonged to tabs in other Tabby windows keep running and appear as extra tabs the next time their session connects.

### Limitations

- Splits are not supported: no tmux panes as Tabby splits.
- All tabs of one session share one tmux client size: the focused tab's size.
- Opening the same session in two Tabby windows shows its windows in both.
- When a tab is drawn again from tmux (after Tabby restarts, on Reconnect, or when the window's active pane changes), it takes the pane's screen, cursor visibility and mouse mode from tmux. Other terminal settings a running program turned on, such as bracketed paste, are missing until the program sets them again.

## Development

Requirements: Node.js 20 or newer, npm, and a Tabby installation.

```sh
npm install
npm run build      # writes dist/index.js
npm test
```

### Loading the plugin into Tabby

Link this repository into Tabby's user plugins folder as `node_modules/tabby-tomux`. Tabby finds plugins there by their `tabby-` name prefix and `tabby-plugin` keyword.

```sh
# macOS
mkdir -p ~/Library/Application\ Support/tabby/plugins/node_modules
ln -s "$PWD" ~/Library/Application\ Support/tabby/plugins/node_modules/tabby-tomux

# Linux
mkdir -p ~/.config/tabby/plugins/node_modules
ln -s "$PWD" ~/.config/tabby/plugins/node_modules/tabby-tomux
```

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:APPDATA\tabby\plugins\node_modules"
New-Item -ItemType Junction `
  -Path "$env:APPDATA\tabby\plugins\node_modules\tabby-tomux" `
  -Target (Get-Location)
```

Avoid `TABBY_PLUGINS` for this repository. Tabby splits its value on `:`, which breaks Windows drive paths. Pointing it at a shared parent folder also makes Tabby load every `tabby-*` checkout in that folder.

Restart Tabby after each `npm run build`. Tabby silently skips a plugin whose `package.json` has no `author` field, so keep it. Check that the plugin loaded: Tabby's log file contains `tomux plugin loaded`. The log is `log.txt` in Tabby's data folder (`~/Library/Application Support/tabby` on macOS, `%APPDATA%\tabby` on Windows, `~/.config/tabby` on Linux).

### Test host

Use a host you can SSH into that has tmux 3.x, with a Tabby SSH profile for it. Two problems seen when developing on macOS:
- **Local Network permission.** Until Tabby is allowed under System Settings → Privacy & Security → Local Network, its connections to LAN addresses fail with "No route to host". This includes its proxy commands. As a stopgap, forward a local port with `ssh -N -L 127.0.0.1:2222:localhost:22 <host>` and point the profile at `127.0.0.1:2222`.
- **Agent login failure without an agent.** With a private key set and no SSH agent running, Tabby 1.0.238 first tries agent login with the key's `.pub`. That attempt fails with `Key(AgentFailure)`, and every later login attempt on the connection then fails with "Inconsistent". Setting the profile's authentication method to "Public key" avoids it.

### Private settings

Keep anything specific to your machine or network, such as a test host's address, in `.env.local`. Git ignores that file. Never put it in committed files.

## License

GPL-3.0-only. Includes code ported from [tmux-integrated](https://github.com/pcassidy75/tmux-integrated); see [NOTICE](NOTICE).
