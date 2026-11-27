# Design

## Context

See proposal.md (Why) and `specs/tmux-tab-ssh-tools/spec.md` for the required behaviour.

Current state (from `add-tomux-plugin`):
- `TomuxTabComponent` extends tabby-ssh's `SSHTabComponent` (D3). Its template is `BaseTerminalTabComponent.template` plus tomux's own keyboard-interactive panel, and it sets `enableToolbar = false`.
- So it already inherits everything the SSH toolbar calls: `reconnect()`, `openSFTP()`, `showPortForwarding()`, `onClick()` (closes the SFTP panel), and the fields `sftpPanelVisible`, `sftpPath` and `sshSession`. Tabby's "Open SFTP panel" tab menu item and the `open-sftp` hotkey check `instanceof SSHTabComponent`, so they already reach tomux tabs, but nothing draws the panel.
- `TomuxPaneSession.supportsWorkingDirectory()` returns `false`, and `getWorkingDirectory()` returns `null`.

What Tabby makes available (checked in the tabby-ssh and tabby-terminal bundles):
- The SSH tab's toolbar is `<terminal-toolbar [tab]="this">` holding a connection dot, a `user@host:port` label, a working-directory tip dropdown, and the Reconnect / SFTP / Ports buttons. `TerminalToolbarComponent` is exported by tabby-terminal's module, which tomux already imports. The Pin/Unpin button and the `toolbar-enabled` / `toolbar-pinned` host classes come from `BaseTerminalTabComponent` and its styles.
- `<sftp-panel>` is declared in `SSHModule` but **not exported**, so tomux's template can't use it. The `SFTPPanelComponent` class is a public runtime export of tabby-ssh. Its inputs are `session`, `path` and `cwdDetectionAvailable`; its outputs are `pathChange` and `closed`.
- `showPortForwarding()` opens `SSHPortForwardingModalComponent` through `NgbModal` by class, with `modal.session = this.sshSession`. No template entry is needed.
- The `panelSlide` animation trigger is part of `BaseTerminalTabComponent.animations`, which tomux already uses.
- The connectable base's `reconnect()` destroys the session and then calls `initializeSession()`. That releases tomux's reference and acquires it again. The registry's idle delay keeps the control connection open in between, and destroying a `TomuxPaneSession` only stops listening; it never kills the window.

## Goals / Non-Goals

**Goals:**
- Reuse Tabby's own toolbar, SFTP panel and port forwarding dialog, so tomux tabs look and behave like SSH tabs and pick up upstream fixes.
- Keep every use of Tabby internals in `src/tabbyAdapter.ts`, as AGENTS.md requires.

**Non-Goals:**
- No SFTP or port forwarding code of tomux's own.
- No change to how the control connection or SSH session is shared or ref-counted.
- No new profile options. The toolbar is always available, as in SSH tabs.

## Decisions

### T1. Template: base template + a copy of the SSH toolbar block

The tomux template becomes `BaseTerminalTabComponent.template`, then a `<terminal-toolbar [tab]="this">` block copied from the SSH tab, then a host for the SFTP panel, then the existing keyboard-interactive panel. `enableToolbar` becomes `true`.

The toolbar block keeps the connection dot, the Reconnect button and the SFTP and Ports buttons with the SSH tab's `*ngIf` conditions (`session && session.open`; Ports also requires `hostApp.platform !== Platform.Web`). The label is `{{profile.options.user}}@{{profile.options.host}}:{{profile.options.port}}` followed by the session name in a muted span.

The **working-directory tip dropdown is left out**. Its condition is `!session.supportsWorkingDirectory()`, which is never true for a connected tomux tab after T3. Leaving it out also avoids importing `NgbModule` only for the dropdown.

- *Alternative rejected:* inheriting the SSH tab's template. tomux can't use it because it contains `<sftp-panel>` and `<keyboard-interactive-auth-panel>`, which are not exported to tomux's module (the reason D3 used the base template).
- *Checked (task 1.2, 2026-11-22):* the toolbar and `sftp-panel` markup in the tabby-ssh that ships with Tabby 1.0.238 is the same as in the 1.0.231 typings package. Note that `SSHTabComponent`'s constructor sets `enableToolbar = true` in 1.0.238; tomux currently overrides it with `false`.

### T2. SFTP panel created in code, through the adapter

`tabbyAdapter.ts` gets a helper that takes a `ViewContainerRef` (the template's `<ng-container #sftpHost>`) and creates `SFTPPanelComponent` there with `createComponent`. It sets `session`, `path` and `cwdDetectionAvailable = true` through `ComponentRef.setInput()`, subscribes to `pathChange` (to update `sftpPath`) and `closed` (to set `sftpPanelVisible = false`), adds `bg-dark` to the host element, and stops click propagation on it so clicks inside the panel don't reach the tab's `onClick()`. It returns a handle the tab destroys when the panel closes.

Angular creates the panel with the template scope of `SSHModule`, where it was declared, so its own dependencies (the filesize pipe, ngb dropdowns, the SFTP modals) resolve without tomux importing them.

The tab turns `sftpPanelVisible` into an accessor (installed by the adapter's `installSftpPanelAccessor()`): the setter creates the panel when it becomes `true` and both the `sshSession` and the tab's pane session are open, and destroys it when it becomes `false`. This catches every path Tabby uses, because they all only assign the field: `openSFTP()` (toolbar, tab menu, hotkey), `onClick()` and the panel's `closed` output. `SSHTabComponent`'s constructor assigns `sftpPanelVisible = false` before the view exists, so the setter must do nothing while the view container is not yet available. If a future tabby-ssh build defines `sftpPanelVisible` as a standard class field, it becomes an own property that hides the accessor; `repairSftpPanelAccessor()` removes it in `ngOnInit` and logs a warning. When the panel is requested but tabby-ssh doesn't export it (the tab menu and hotkey still ask, though the toolbar hides the button), the tab shows a notification instead of doing nothing.

The panel's position comes from SSH-tab CSS (`position: absolute; height: 80%; width: 100%; bottom: 0; z-index: 5`). That CSS is scoped to the SSH tab component, so the adapter helper applies it to the created element directly. It must not set `display`: the panel's own `:host { display: flex; flex-direction: column }` is what gives its file list (`flex: 1 1 0; overflow-y: auto`) a bounded height to scroll in (code review).

- *Alternative rejected:* re-declaring or wrapping `SFTPPanelComponent` in tomux's module. A component can be declared in only one module, and it is not standalone.
- *Alternative rejected:* tomux's own SFTP panel built on tabby-ssh's exported `SFTPSession`. It's a lot of UI to own and diverges from Tabby. This is the fallback only if the spike (task 1) shows that creating the panel in code doesn't work.
- *Alternative rejected:* polling `sftpPanelVisible` in `ngDoCheck`. It works but runs on every change detection; the accessor is exact. `ngDoCheck` stays the fallback if a Tabby code path turns out to bypass the setter.
- *Animation:* animation triggers apply only to elements in a template, so `panelSlide` is replayed on the host element with the browser's Web Animations API (`element.animate`), which needs no `@angular/animations` dependency (enter: from `translateY(25%)`, opacity 0, over 100 ms ease-out; leave: the reverse, then destroy). It is skipped when Tabby's `accessibility.animations` setting is off, as the SSH tab's `[@.disabled]` does.

**Spike result (task 1, 2026-11-22, Tabby 1.0.238 driven through its DevTools port, test host Debian with tmux 3.5a):** `createComponent(SFTPPanelComponent, { environmentInjector, elementInjector: tab.injector })` in a live tomux tab works in Tabby's JIT setup. `setInput()` sets `session`, `path` and `cwdDetectionAvailable`. The panel listed `/`, navigated to `/etc` and back up, emitted `pathChange`, built its file context menu (Copy full path, Edit locally, Create directory, Download, Delete; Tabby's SFTP menu providers resolve through the tab's injector), and its close button emitted `closed`, after which the view was destroyed and removed from the page. No errors were logged. Upload and download open native file dialogs, which DevTools can't operate; they are checked by hand in task 3.4. `AnimationBuilder` (`BrowserAnimationBuilder`) is available from Tabby's injector, so the animation above is cheap to keep.

### T3. Working directory from tmux

`TmuxControlClient` gets `paneCurrentPath(paneId)`, which sends `display-message -p -t <pane> "#{pane_current_path}"` and returns the reply with only its final line ending stripped (all reply lines joined, so a directory name containing a newline survives), or `null` when it is blank. `TomuxPaneSession.getWorkingDirectory()` calls it and returns `null` when the command fails, the connection has ended, or tmux doesn't answer within 1.5 s (Tabby awaits it before opening the SFTP panel, and the reply can queue behind a large paste). `supportsWorkingDirectory()` returns whether the connection is live.

Effects in Tabby (checked in the bundles): `openSFTP()` uses the path as the panel's start folder and keeps the previous `sftpPath` on `null`; tabby-terminal's tab menu shows "Copy current path"; and the SSH-style working-directory tips stay hidden. "Save as profile" already calls `getWorkingDirectory()` and so writes `cwd` into the saved SSH profile. That is harmless and out of scope (see proposal).

- *Alternative rejected:* following OSC 7 sequences from the pane output, as Tabby's SSH shell session does. It needs shell setup on the host, and tmux already knows the answer.
- *Alternative rejected:* tracking `pane_current_path` through a control-mode subscription (`refresh-client -B`, tmux 3.2 or newer). It isn't needed, because Tabby asks for the path only when it needs it.

### T4. Reconnect: the inherited flow, made safe to click

The toolbar calls the inherited `reconnect()` (confirmed with the user: the same as SSH tabs). It re-runs tomux's `initializeSession()`, which turns the tab's `windowId` into an `adopt` intent (`connectIntent()`). So a healthy connection rebinds and re-captures the same window, a dropped one reconnects first, and a window that no longer exists closes the tab (`decideBinding` → `close`).

Before this change Reconnect was reachable only through a hotkey. Making it a button exposed three problems in that flow (code review), fixed here:
- **Tabby could close the tab.** `reconnect()` destroys the pane session first, and Tabby's `onSessionClosed()` destroys the tab when the profile's `behaviorOnSessionEnd` is `close`, or `auto` after the user typed `exit` or Ctrl-D. The tab overrides `shouldTabBeDestroyedOnSessionClose()` to return `false`: tomux closes its tabs itself on tmux's `window-close` and `%exit`. A lost connection now always offers reconnecting.
- **Two connects at once.** A double-click, a click during a slow login, or `behaviorOnSessionEnd: reconnect` (which calls `reconnect()` from inside `reconnect()`) ran `initializeSession()` twice, leaking a connection reference. `initializeSession()` now runs through `SingleFlight`: a call made while a connect is running joins it.
- **History appended twice.** Unless the profile clears service messages on connect, the old screen stayed and the re-captured history was written below it. A reconnecting tab now starts its pane session with `redraw`, which clears screen and scrollback before the snapshot.

The connection-lost handler runs outside Angular's zone, so it now runs its work inside `NgZone`; otherwise a pinned toolbar kept showing the tab as connected.

### T5. Port forwarding needs no tomux code

`showPortForwarding()` is used as inherited. The forwards belong to the multiplexed `SSHSession`, which the control connection keeps alive with `ref()` (D4). That gives the spec's shared and lifetime behaviour, and profile forwards are applied by `SSHSession` when it starts. The README documents that forwards apply to the whole host connection.

### T6. Adapter surface

Added to the `@hidden` / runtime-export list that `tabbyAdapter.ts` owns:
- `SFTPPanelComponent` (runtime export of tabby-ssh) and creating it in code;
- `SSHTabComponent` members `openSFTP()`, `showPortForwarding()`, `reconnect()`, `onClick()`, `sftpPanelVisible`, `sftpPath` and `Platform`, and the inherited `shouldTabBeDestroyedOnSessionClose()` the tab overrides.

The adapter's `installSftpPanelAccessor()`, `repairSftpPanelAccessor()` and `openSftpPanelForTab()` are the only code that redefines `sftpPanelVisible` or reads and writes `sftpPath` and `sshSession` for the panel. The tab's template binds the inherited `reconnect()`, `openSFTP()`, `showPortForwarding()` and `Platform` exactly as tabby-ssh's own SSH-tab template does, as D3 already does for `activeKIPrompt`.

`loadTabbySsh()` treats a missing `SFTPPanelComponent` as non-fatal: the tab hides the SFTP button and logs a warning, and the rest of tomux keeps working.

## Risks / Trade-offs

- [Creating `SFTPPanelComponent` in code might fail in Tabby's JIT setup, for example if its declarations don't resolve outside `SSHModule`] → Spike first (task 1) in a running Tabby. If it fails, stop and revisit T2 (own panel on `SFTPSession`, or an upstream request to export `sftp-panel`) before building the rest.
- [Upstream changes the toolbar markup or the `SSHTabComponent` members] → All of it is listed in T6 and reached through the adapter. The copied toolbar block names the upstream file it came from, so it is easy to compare.
- [`pane_current_path` is empty on some platforms, or when the pane runs a process that changed directory] → `getWorkingDirectory()` returns `null` and the SFTP panel falls back to its default folder, as the spec requires.
- [Reconnect while connected reads like "nothing happened"] → Accepted: the user chose SSH-tab parity. The tab does redraw from tmux, which is a fix for display glitches.
- [Port forwards are shared across tabs of one host, which can surprise users] → It's the same in Tabby's multiplexed SSH tabs. The README says so.

## Migration Plan

None. The toolbar appears after updating the plugin, there is no setting or stored data to migrate, and rolling back is reinstalling the previous version.
