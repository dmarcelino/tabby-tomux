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
3. Optional: choose this tomux profile under Settings → Profiles & connections → **Default profile for new tabs**. Then `+` and the new-tab hotkey open a new tmux window on that host. This is one global setting, so `+` always goes to that host, whichever tab is active.

## How it works

- **One tab per tmux window, one pane per tab.** Each tomux tab shows one window of the tmux session. If a window has several tmux panes, the tab shows the active pane and the others keep running.
- **Opening the profile:** if the session doesn't exist, tomux creates it and the tab shows its first window. If it exists, the tab shows its lowest-numbered window, and the session's other windows open as extra tabs. Once connected, opening the profile again creates a new window.
- **Windows created elsewhere** (tmux's new-window key, another computer) open as new tabs.
- **Titles:** a tab shows its tmux window's name. Renaming in tmux renames the tab. Renaming the tab in Tabby renames the tmux window.
  - A window you haven't named is called `tmux:<index>`. Its tab shows the title the program in it sets, as a local terminal tab does. Claude Code, for example, names the tab after its task. tomux never copies that title into tmux.
  - A name you gave the window wins over the program's title. To make the tab follow the program again, rename it to `tmux:<index>`, in Tabby or in tmux.
  - If your shell sets the terminal title at every prompt (many bash and zsh setups do), unnamed tabs show that title, for example `user@host: ~/src`, instead of `tmux:<index>`. To keep `tmux:<index>`, turn on **Disable dynamic tab title** in the tomux profile.
  - After a reconnect, a restart or a pane switch, the tab shows the title tmux remembers for the active pane.
- **Tabby's tab hotkeys** (next/previous tab, go to tab N, move tab) work as usual. Moving a tab doesn't reorder windows in tmux.

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
