# Design

## Context

See `proposal.md` for motivation. This is a new repository; the reference code lives alongside it:

- **Tabby** (`../tabby`, checked at `467ce8eb`, 2026-10-06): the host app. Plugins are Angular modules loaded the same way as built-in ones.
- **tmux-integrated** (`../tmux-integrated`, `0f92f4a`, GPL-3.0-only): the VS Code extension whose design tomux follows. Its `doc/ARCHITECTURE.md` documents the races it fixed; those notes are the checklist for this design.
- **tabby-tmux** (`../tabby-tmux`, `2248485`, package.json declares MIT, no LICENSE file): an existing Tabby plugin that shows a tmux session as one tab with its own bottom window bar. Useful for how to integrate with Tabby (zone handling, build setup); its `doc/DESIGN_NATIVE_TAB_DECISION.md` explains why it rejected native tabs.

Facts from Tabby's code that shape this design:

1. **`+` and the new-tab hotkey** open `config.terminal.profile`, whatever its type (`tabby-local/src/services/terminal.service.ts:21`, `buttonProvider.ts`). A tomux profile set as default therefore drives `+`.
2. **Profiles open through `AppService.openNewTab`**, which wraps the tab in a `SplitTabComponent` (`app.service.ts:205-216`).
3. **Window close does not reliably skip `destroyed$`.** `closeWindow()` → `closeAllTabs()` → `tab.destroy(true)` on each top-level tab, but `SplitTabComponent.destroy()` takes no argument and calls `child.destroy()` on every child (`splitTab.component.ts:787-791`). A tomux tab inside a split container therefore emits `destroyed$` on window close exactly as on a user close.
4. **Recovery** is driven by `TabRecoveryProvider`. Tokens are saved to `localStorage` on tab changes (debounced 1 s), every 30 s and on `closeWindow()`. Only the main window restores (`app.service.ts:113`). Recovered tabs are added with `openNewTabRaw` (no wrapper).
5. **`getRecoveryToken(options)`** is also used for duplicate (no `includeState`), restart tab and the closed-tab stack (`includeState: true`). Restart recovers the new tab first, then calls `closeTab()` on the old one (`app.service.ts:513-530`).
6. **SSH**: `tabby-ssh` exports `SSHTabComponent` (marked `@hidden`) and `SSHMultiplexerService`. `SSHTabComponent.setupOneSession(injector, profile)` is public. It reuses a matching authenticated `SSHSession` when `reuseSession` is on (the default), otherwise connects and shows prompts in the tab. `SSHSession` (not exported as a type) has public `ref()`/`unref()`, `openShellChannel()` and the `russh` client in `ssh`. `ConnectableTerminalTabComponent` writes `type: app:<profile.type>-tab` and `savedState` into its token.

## Goals / Non-Goals

**Goals:**
- A plugin, not a fork: depend on Tabby's public API, and keep every use of a `@hidden` Tabby API behind one small adapter module so a Tabby update breaks one file.
- Reliability over features: tmux is the only source of truth for which windows exist; Tabby tabs are views onto it. When unsure, keep the tmux window alive.
- Port tmux-integrated's protocol layer instead of rewriting it, so its race fixes come along.

**Non-Goals:**
- Changes to Tabby itself. An upstream fix for `SplitTabComponent.destroy()` may be offered separately, but tomux must not depend on it.
- tmux panes/splits, `swap-window`/`move-window` sync, tmux copy mode integration, flow control (`pause-after`), and the iTerm2 "tmux dashboard". These are not needed for the specs.

## Decisions

### D1. Architecture

```
 Tabby window
 +---------------------------------------------------------+
 | [api] [logs] [vim] [+]                                  |
 +---------------------------------------------------------+
    |       |       |
  TomuxTab TomuxTab TomuxTab     extends SSHTabComponent (via adapter)
    |  TomuxPaneSession          extends BaseSession: input -> send-keys,
    |                                                 %output -> frontend
    +-------+-------+
            v
  TomuxConnectionRegistry        key = SSH multiplexer key + session name
            v
  TomuxConnection                one per host+session, ref-counted
    - TmuxGateway                ported from tmux-integrated
    - window ownership map       window id -> owning tab
    - adoption queue             unclaimed windows after restore
            |
  control channel                tmux -CC new-session -A -s <name>
            |
  SSHSession (Tabby's)           ref()'d by the connection
```

Module layout (one file per role, mirroring tmux-integrated): `gateway.ts` (ported), `windowTitle.ts` (ported), `sendKeys.ts` (ported input encoding), `connection.ts`, `connectionRegistry.service.ts`, `paneSession.ts`, `tomuxTab.component.ts`, `profileProvider.ts`, `recoveryProvider.ts`, `closeIntent.service.ts`, `tabbyAdapter.ts` (all `@hidden` Tabby access), `index.ts`.

### D2. Transport: own channel on Tabby's SSH session

The control stream runs on its own SSH channel of Tabby's existing `SSHSession`. It isn't typed into a visible shell (tabby-tmux's approach) or carried by a local `ssh.exe` (tmux-integrated's node-pty approach).
- **Preferred**: an exec channel with a PTY running `tmux -CC new-session -A -s <name>`. No shell, no echo, no banner, and the channel closes when tmux exits.
- **Fallback** (if the russh binding cannot exec): `SSHSession.openShellChannel()`, then write `exec tmux -CC new-session -A -s '<name>'`. The gateway discards everything before the control-mode DCS introducer (`ESC P 1000 p`), the same detection tabby-tmux's `TmuxOutputInterceptor` does, and treats `ESC \` as the end.
- **Why not a local process**: on Windows the stream would pass through ConPTY, which is the layer that forced the Windows Terminal PRs and YaTerm to add workarounds for `-CC`. Tabby's SSH client is pure JS/Rust bytes.
- **Spike 1 result (2026-11-22): exec works; the shell fallback is not needed.** Tested with `russh` 0.1.38 (the version Tabby ships) from Node against Debian 13 + tmux 3.5a. The sequence `auth.openSessionChannel()` → `activateChannel()` → `requestPTY('xterm-256color', …)` → `requestExec('tmux -CC new-session -A -s <name>')` produced:
  - `ESC P 1000 p` as the first bytes, with no shell output before it, followed by `%begin/%end`, `%window-add`, `%sessions-changed` and `%session-changed`;
  - command responses in order, and typed UTF-8 and double spaces delivered intact through `send-keys -l`;
  - on `kill-session`, `%exit` then `ESC \`, then `eof$` and `closed$` on the channel.

  Lines arrive as `\r\n` because of the PTY, and the gateway drops the bare `\r`, as tmux-integrated's does. The login banner a login shell prints appears as `%output` of the pane, which is correct pane content. The `Channel` API has `data$`, `eof$`, `closed$`, `write()`, `resizePTY()` and `close()`. The same sequence then ran **inside Tabby 1.0.238** on the `SSHSession` of a logged-in SSH tab, with the same result. That session came from `SSHMultiplexerService.getSession(tab.profile)`, where `SSHMultiplexerService` is the class from the `tabby-ssh` module found through the global module paths (D11), and it was the very instance the tab held.

Reference counting, as observed:
- With tomux holding `session.ref()`, closing the SSH tab through `AppService.closeTab` left the SSH connection and the control channel working; a ping was answered.
- `kill-session` produced `eof$` and `closed$` on the channel and left the SSH connection up.
- `session.unref()` to zero called `destroy()`, and the TCP connection was gone within about 10 s. A later `openSessionChannel()` failed with `SendError`.
- **`SSHSession.open` stays `true` after `destroy()`**, because Tabby never resets it. tomux must use `willDestroy$` (and channel `closed$`) for liveness, never `open`.

### D3. Authentication: TomuxTab extends SSHTabComponent

`TomuxTab` extends `SSHTabComponent` so the first tab of a host gets Tabby's connection UI for free: the spinner, host-key and password/keyboard-interactive prompts, error messages and "press any key to reconnect". It overrides `initializeSession()` to:
1. run the base terminal setup (skipping `SSHTabComponent`'s own shell creation);
2. call `setupOneSession(injector, sshProfile)` to get an authenticated `SSHSession` (shared through the multiplexer);
3. get the `TomuxConnection` from the registry, then bind to a window (D5);
4. `setSession(new TomuxPaneSession(connection, windowId))`.

It also overrides `getRecoveryToken()` (D7) and `canClose()`, which returns `true` without SSH's "Disconnect from host?" prompt, because closing a tab kills one window rather than the connection.

- **Alternative rejected**: a separate visible "bootstrap" SSH tab that authenticates and is then replaced. It's loosely coupled, but adds a tab that appears and disappears plus extra lifecycle states.
- **Alternative rejected**: subclassing only `BaseTerminalTabComponent` and calling `SSHSession` directly. It would lose Tabby's auth prompts, which are rendered by `SSHTabComponent`'s template.
- **Spike 2 result (2026-11-22, Tabby 1.0.238): the subclass approach works.** A throwaway `TomuxSpikeTabComponent extends SSHTabComponent`, with its own `@Component`, overrode `initializeSession()` to call `ConnectableTerminalTabComponent.prototype.initializeSession`, then the inherited `setupOneSession()`, then `setSession()` with its own `BaseSession`. Observed:
  - It logged in, showed Tabby's connection messages and the host-key prompt, and typed input reached its session (UTF-8 intact).
  - A second tab for the same profile got the **same** `SSHSession` instance, and the host saw one connection.
  - **Password login** uses Tabby's global password dialog (`ngbModal`), so it appears whatever template tomux uses. Cancelling it ends the attempt with "Authentication rejected" written in the tab. Completing a password login was not tested; that needs the user to type a real password.
  - **Keyboard-interactive** prompts are rendered by the tab's template. Tabby's own panel (`keyboard-interactive-auth-panel`) is declared in `SSHModule` but not exported, so tomux renders a small panel of its own bound to the inherited `activeKIPrompt`. Untested: the test host disables keyboard-interactive login.
  - **The template is not inherited.** tomux uses `BaseTerminalTabComponent.template` plus its own prompt panel, so the SSH toolbar (SFTP, Ports, Reconnect) is simply absent. Set `enableToolbar = false`. *(Superseded by change `add-ssh-toolbar`, which brings the toolbar, SFTP panel and port forwarding back; see its design T1 and T2.)* The inherited SSH hotkeys are harmless: `restart-ssh-session` → `reconnect()` re-runs tomux's `initializeSession()`, and `open-sftp` does nothing without the panel.
  - A token with `type: 'app:tomux-tab'` is not claimed by Tabby's SSH recovery provider.
  - **Angular zone:** tabs opened from code that runs outside Angular's zone (anything driven by tmux notifications or SSH callbacks) don't render until change detection runs. Open tabs inside `NgZone.run()`, as tabby-tmux does.
  - The typings in the published `tabby-ssh` 1.0.231 lack the `SSHTabComponent` export, so its type is imported from `tabby-ssh/typings/components/sshTab.component`. tomux needs Tabby 1.0.238 or newer at runtime, and the adapter fails with a clear message otherwise.

  `@hidden` or unexported Tabby APIs used, all reached through `tabbyAdapter.ts`:
  - `SSHTabComponent` (runtime export, loaded by path);
  - its members `setupOneSession()`, `sshSession`, `activeKIPrompt` and `enableToolbar`;
  - `SSHMultiplexerService.getSession()`;
  - the `SSHSession` instance's `ssh`, `ref()`, `unref()` and `willDestroy$`;
  - the `russh` `AuthenticatedSSHClient` channel API (`openSessionChannel`, `activateChannel`, `requestPTY`, `requestExec`).

### D4. Connection registry and lifecycle

- Key: the same host/port/user/proxy/jump fields `SSHMultiplexerService` uses, plus the tmux session name. Since `getMultiplexerKey` is private, the adapter recomputes the key from the profile.
- `getOrConnect(key)` memoizes the in-flight promise (tmux-integrated's race fix #1), so N restored tabs produce one connection.
- The connection `ref()`s the `SSHSession` while it is open and `unref()`s on close, so closing other SSH tabs on that host does not drop it.
- Reuse runs a ping first (`display-message -p __ping__`, 5 s timeout), as tmux-integrated does. On timeout the connection is torn down and rebuilt.
- After the handshake: `tmux -V` is checked against the minimum (2.1, for `refresh-client -C`), then `list-windows -F` gives the windows.
- Ref-counting: each bound tab holds a ref. When the count reaches zero, the connection detaches (`detach-client`) after a short idle delay, so a quick restart-tab or close-then-`+` does not reconnect. It never kills.
- On `%exit` or channel close, every bound tab's `TomuxPaneSession` is closed. A clean `%exit` (session ended) closes the tabs. A channel error leaves the tabs open as disconnected, and Tabby's reconnect re-runs D3, which rebinds by window id.

### D5. Binding a tab to a window

A tab is created with one of three intents, decided by how it was opened:

| Intent | Source | Binding |
|---|---|---|
| `adopt(windowId)` | restore at startup, restart tab | Bind if the window exists and is unowned. Otherwise close the tab (restore) |
| `reopen(windowId)` | closed-tab stack | Bind if exists and unowned, else `new` |
| `new` | profile open, `+`, duplicate | If the connection was just made: bind to the initial window (new session) or the lowest-index unclaimed window. Otherwise `new-window -P -F '#{window_id} #{pane_id} #{window_index}'` |

Ownership is a map on the connection, `windowId → tab`. Binding to an owned window is refused, which enforces "no two tabs on one window".

Unclaimed windows (`tmux-tab-recovery` spec) are opened by the connection after a grace period. That period ends when Tabby's startup restore finishes or 2 s after connect, whichever is later, so restored tabs claim their windows first (tmux-integrated fix #2). Unclaimed windows are taken one at a time and the queue is never cleared wholesale (fix #3).

**Reservations (added during implementation).** Tabby starts a restored terminal tab's session only when the tab is first shown. Until then, a background tab's window looked unclaimed, and the leftover-window adoption opened a second tab for it, which also changed the tab order. Fixes:
- A tab with an `adopt` or `reopen` intent **reserves** its window, keyed by connection key, as soon as it is created.
- Adoption, `%window-add` handling and other tabs' binding all skip reserved windows.
- When a connection opens, reserved tabs whose window no longer exists are closed at once instead of on first click.

**Session name is fixed per tab.** A tab takes its session name once, at creation: from the recovery token when restored, otherwise from the profile. Tabs opened for unclaimed windows take the connection's session name. Editing a tomux profile later therefore cannot move open tabs, or their saved tokens, to another session.

`%window-add` for a window we did not create: tomux sends a no-op command as a barrier and opens a tab for the window only if it is still unowned when the barrier returns. Because tmux answers commands in order, our own `new-window` response has been processed by then. This is a small addition over tmux-integrated, which only adopts on connect.

### D6. Close semantics: kill only on proof

Fact 3 means `destroyed$` cannot be trusted. tomux records **close intent** instead:
- `closeIntent.service.ts` wraps `AppService.closeTab` once at plugin init through the adapter. Before delegating, it marks every tomux tab under the tab being closed. This is the path behind the tab close button, the close-tab hotkey and the context-menu close actions.
- On `destroyed$` (or destroy), a tomux tab kills its window only if it is marked **and** the connection still lists it as the window's owner, using `kill-window -t @id` with errors tolerated.
- Restart tab: the recovered tab adopts `@id` first, taking ownership, so the old tab's kill check fails and the window survives.
- Window close, crash, ngOnDestroy teardown and lost connection: no mark, so no kill, and the connection detaches.
- If the `closeTab` wrapper cannot be installed (Tabby changed), tomux logs a warning and **never kills**. A wrongly kept window costs one extra tab on the next connect; a wrongly killed one costs the user's work. (This is tmux-integrated's "decide from intent, not timing" rule.)
- **Spike 3 result (2026-11-22, Tabby 1.0.238).** A `closeTab` wrapper marked the tomux tabs under the closed tab, and every tomux tab logged `destroyed$` with its mark. Results:

  | Case | `destroyed$` NEXT? | Marked? |
  |---|---|---|
  | Tab ×, close-tab hotkey, context menu Close / Close other tabs, close a whole split | yes | yes |
  | Quit app; `app.closeWindow()` (custom title-bar button); OS window close uses the same window `close` → `host:window-close-request` path as quit | **yes, for every tab** (confirms fact 3) | no |
  | `kill -9` of the Tabby process | no events | n/a |
  | Restart tab | yes | no, with the rule below |
  | Duplicate tab / Tabby split action | no (new tab only); token has no `includeState` | n/a |
  | Reopen closed tab | new tab gets the token saved by `closeTab`, with `windowId` and the user-close tag | n/a |
  | `close-pane` hotkey, or context menu Close on a pane inside a split | yes | **no**: Tabby calls `tab.destroy()` directly, not `closeTab` |

  Two corrections to the plan above:
  1. **Restart closes the old tab before creating the new one** in Tabby 1.0.238. The order is `getRecoveryToken` → `closeTab` → recover → create, so the ownership hand-off alone cannot protect the window. Fix: **mark only when `closeTab` is called with `checkCanClose === true`.** Every user-initiated close passes `true`: the tab header button, middle click, the context menu and the close-tab hotkey. `restartTab` is the only caller passing `false` (`app.service.ts:533`). The ownership check stays as a second guard.
  2. Marks must be read **synchronously** in the `destroyed$` handler. `closeTab` destroys tabs synchronously inside the wrapped call, and the wrapper clears its marks in `finally`. A `closeTab` that returns early (pinned tab, `canClose()` false) therefore leaves no stale mark.

  Tabby's `log.txt` is written asynchronously and loses lines during window teardown. Anything that must survive shutdown has to be written synchronously.

- **Alternative rejected**: timing-based kill (defer the kill and cancel it on shutdown). tmux-integrated moved away from this after it killed sessions.
- **Alternative rejected**: subscribing to `hostWindow.windowCloseRequest$` to set a "shutting down" flag. Tabby's custom title-bar close button calls `app.closeWindow()` directly and bypasses it.

### D7. Recovery token and provider

```
{ type: 'app:tomux-tab', tomuxProfileId, sessionName,
  windowId?   // only when options.includeState
  intent?: 'adopt' | 'reopen' }
```

- `includeState` absent (duplicate): no `windowId`, so the tab opens with intent `new`.
- `includeState` present: `windowId` is included. The recovery provider maps startup restore and restart to `adopt`, and the closed-tab stack to `reopen`. It tells them apart by having `closeIntent.service` tag tokens of tabs it marked as user-closed, since those are the tokens pushed onto `closedTabsStack`. Spike 3 confirmed that `closeTab` takes the token while the mark is set, and that the reopened tab receives the tag.
- The token never includes `savedState`, so Tabby does not replay the old screen. The screen comes from `capture-pane` (D8).
- `type` must not be the inherited `app:ssh-tab`, or Tabby's SSH recovery provider would restore a plain SSH tab.

### D8. Pane I/O (ported from tmux-integrated)

- **Input**: tmux-integrated's hybrid `send-keys` encoding. Known keys are sent by name, safe ASCII runs with `send-keys -lt`, non-ASCII text with `send-keys -l`, and unknown escape sequences hex-encoded atomically. Chunks are capped at 1,024 bytes and written in order through the gateway queue.
- **Output**: `%output`/`%extended-output` are decoded octal → bytes → a per-pane `StringDecoder`, keeping ESC and dropping only the PTY's bare `\r`.
- **Adopt**: `capture-pane -p -e -J -S - -t %pane` for history and screen, then cursor position from `display-message -p '#{cursor_x},#{cursor_y}'`. Live output is buffered until the snapshot has been written.
- **Resize**: 100 ms debounce, then `refresh-client -C cols,rows`. There's one client size per connection, so the active tab's size wins. All tabs of a Tabby window are the same size anyway.
- **Active window**: when a tomux tab gains focus, `select-window -t @id`, so tmux's notion of the current window follows Tabby.

### D9. Titles

`windowTitle.ts` is ported unchanged, including `pickTerminalTabTitle` and `TabTitleSync` (echo tracking, stale-title classification, dedup). Tabby glue:
- **tmux → Tabby**: `%window-renamed` sets the tab title.
- **Tabby → tmux**: watch the tab's custom title (Tabby's "Rename tab"). A new value that this tab never emitted is treated as a user rename: `set-option -w automatic-rename off ; rename-window`.
- tmux-integrated's re-assert timers exist because of VS Code title races. Tabby sets titles synchronously, so they are not ported unless testing shows a need.

### D10. Profile provider

`TomuxProfileProvider` (`id: 'tomux'`) has options `{ sshProfileId, sessionName = 'main' }`, a small settings component with an SSH profile picker and a session-name field that rejects `.`, `:` and empty names, and no built-in profiles. `getNewTabParameters` resolves the SSH profile through `ProfilesService` and returns `{ type: TomuxTab, inputs: { profile: sshProfile, tomux: { tomuxProfileId, sessionName, intent: 'new' } } }`. If the SSH profile is missing, the tab shows an error instead of connecting.

### D11. Licensing and packaging

The repository is GPL-3.0-only, with tmux-integrated's copyright notices kept in each ported file and a NOTICE listing what was ported, from which commit. Build setup follows tabby-tmux: webpack, Angular 15 peer dependencies, the `tabby-*` packages as externals, and the `tabby-plugin` keyword so Tabby's plugin manager can find it. Tests use vitest. The gateway, title and send-keys tests are ported along with the code.

**Loading `tabby-ssh` (found during task 1.1).** Tabby hands plugins its own instances of Angular, rxjs, `tabby-core`, `tabby-local`, `tabby-settings` and `tabby-terminal` (`app/src/plugins.ts:22-49`), but not `tabby-ssh`. A plain `require('tabby-ssh')` from tomux would resolve through Node's normal lookup. During development that finds the npm copy in this repo's `node_modules`. After a plugin-manager install it finds whatever npm placed next to the plugin. Either way it would be a second instance whose `SSHMultiplexerService` and `SSHTabComponent` are not Tabby's. Therefore:
- `tabby-ssh` is a dev dependency only, used for types. It is not a peer dependency, because npm auto-installs peers.
- `tabbyAdapter.ts` loads the runtime module by searching Node's global module paths, where Tabby puts its built-in plugins folder, and requires that absolute path. Because Node caches modules by file path, this returns the instance Tabby already loaded. All other files use `import type` from `tabby-ssh`.
- Built-in plugins load before user plugins, so `tabby-ssh` is already loaded when tomux's module runs. Spike 2 verifies both points.

## Risks / Trade-offs

- **[`@hidden` Tabby APIs change]** → all access goes through `tabbyAdapter.ts`. Tests pin the Tabby version used, and CI builds against the latest Tabby nightly so breakage shows up early.
- **[The `closeTab` wrapper is a monkeypatch]** → it is installed once and checked at startup. If installation fails, tomux falls back to never killing (safe direction). Offer Tabby an upstream fix for `SplitTabComponent.destroy()` and a public "tab closed by user" signal, and drop the wrapper once that exists.
- **[russh binding lacks exec]** → D2 fallback via shell + `exec tmux -CC`, with DCS framing detection.
- **[Extending `SSHTabComponent` brings SSH-only UI]** (SFTP, port forwarding) → hide it in the tomux tab template, or accept it if harmless. Spike 2 decides.
- **[One client size per connection]** → windows larger than the tab could be clipped if another tmux client with a smaller size is attached. tmux's default `window-size` handles this, and it is documented as a known limitation.
- **[`+` is a global default]** → every Tabby window's `+` goes to the same host. Accepted for v1 (proposal).
- **[Heavy output can flood the control channel]** → no `pause-after` flow control in v1. Measured during the stress tasks; added later if needed.
- **[Windows with several panes show only the active pane]** → accepted (spec). Users who split inside tmux see one pane in the tab.

## Migration Plan

New plugin, nothing to migrate. Rollback is uninstalling the plugin: tmux sessions on hosts are untouched, and saved `app:tomux-tab` tokens are ignored by Tabby when no provider claims them.

## Resolved Questions

- Upstream `SplitTabComponent.destroy()` fix: offer it to Tabby after the spikes confirm the analysis (see tasks.md, Workflow follow-up).
- Minimum tmux version: 2.1, as in tmux-integrated. The test host runs tmux 3.5a.
