# Tasks

## 1. Plugin scaffold and dev loop

- [x] 1.1 Create the plugin package (package.json with `tabby-plugin` keyword, Angular 15 / `tabby-core` / `tabby-terminal` / `tabby-ssh` peer and dev dependencies, tsconfig, webpack config modelled on tabby-tmux with `tabby-*` externals, vitest config) and verify `npm run build` produces `dist/index.js` and `npm test` runs with zero tests
- [x] 1.2 Add an empty `TomuxModule` that logs once on load, and verify it appears in Tabby's log when Tabby is started with `TABBY_PLUGINS=<repo path>` (or the plugin is copied into Tabby's user plugins folder on Windows, where `TABBY_PLUGINS` splits on `:`)
- [x] 1.3 Add GPL-3.0-only `LICENSE`, `NOTICE` (ported files, tmux-integrated commit `0f92f4a`) and a README stub with the dev loop from 1.2, and verify the README's steps load the plugin
- [x] 1.4 Set up a test host reachable by SSH with tmux 3.x (an existing server, or a local container/WSL distro running sshd and tmux), add a Tabby SSH profile for it, and verify `ssh` + `tmux -CC new -A -s spike` works from a plain Tabby SSH tab

## 2. Spike 1: control channel on Tabby's SSH session

- [x] 2.1 From a throwaway command in the plugin, get the authenticated `SSHSession` of an open SSH tab through `SSHMultiplexerService`, and try an exec channel with a PTY running `tmux -CC new-session -A -s spike`; verify raw control-mode lines (`%begin`, `%session-changed`) are logged
- [x] 2.2 (Not needed: spike 1 showed exec works, see design D2.) If exec is not available in the russh binding, try `openShellChannel()` + `exec tmux -CC new-session -A -s spike` with DCS-start detection; verify a login banner on the host does not reach the logged protocol lines
- [x] 2.3 Verify that closing the SSH tab the session was borrowed from does not close the control channel while the plugin holds `ref()`, and that `unref()` afterwards closes the SSH connection
- [x] 2.4 Record the outcome (exec vs shell, any russh API names, the ref-count behaviour) in design.md D2/D4 and verify the design no longer lists the unchosen path as open

## 3. Spike 2: a tab that is an SSH tab with its own session

- [x] 3.1 Create a minimal `TomuxTab` extending `SSHTabComponent` that overrides `initializeSession()` to call `setupOneSession()` and then attaches a stub `BaseSession` echoing typed input back; verify a password-protected profile shows Tabby's prompt inside this tab and the echo works after login
- [x] 3.2 Verify a second `TomuxTab` for the same profile reuses the SSH connection without prompting again
- [x] 3.3 Check which inherited SSH UI is visible (SFTP button, port forwarding, reconnect message) and verify each one can be hidden or does no harm; note which `@hidden` members were needed
- [x] 3.4 Verify the tab's own `getRecoveryToken()` with `type: 'app:tomux-tab'` is not claimed by Tabby's SSH recovery provider
- [x] 3.5 Record the outcome in design.md D3, including the list of `@hidden` APIs that will live in `tabbyAdapter.ts`

## 4. Spike 3: telling a user close apart from everything else

- [x] 4.1 Install the `AppService.closeTab` wrapper that marks descendant `TomuxTab`s, and log on every `TomuxTab` destroy whether it was marked; verify the marks for: close button, close-tab hotkey, context-menu close, close other tabs
- [x] 4.2 Verify no mark is logged for: closing the Tabby window through the custom title-bar button, through the OS (Alt+F4 / Cmd+W on the window), quitting the app, and killing the Tabby process
- [x] 4.3 Verify the sequence for restart tab (new tab created before the old one is closed and marked), duplicate (token without `includeState`) and reopen closed tab (token from the closed-tab stack), and that a tab inside a split container behaves the same as a top-level one
- [x] 4.4 Record the outcome in design.md D6/D7. If any case contradicts the design, update the specs or design before continuing, and verify `openspec validate add-tomux-plugin` still passes

## 5. Control-mode protocol (ported)

- [x] 5.1 Port tmux-integrated's `tmuxGateway.ts` (framing, `%begin/%end/%error` matching, command lists, write buffering until `%session-changed`, octal output decoding with per-pane UTF-8 decoders) with its copyright notice, add DCS start/end framing if spike 1 chose the shell fallback, and verify ported plus new unit tests cover split UTF-8, ESC preservation, interleaved notifications and `%error`
- [x] 5.2 Port the typed operations needed here (`newWindow`, `listWindows`, `killWindow`, `renameWindow`, `capturePane`, `refreshClient`, `selectWindow`, version check, ping) onto a transport interface instead of node-pty, and verify unit tests with a fake transport check the exact command strings

## 6. Connection lifecycle

- [x] 6.1 Implement `TomuxConnection` on the channel from spike 1: handshake, minimum tmux version check with an error naming both versions, initial `list-windows`, `%exit` and channel-close handling, `detach-client` on release; verify with unit tests using a fake transport
- [x] 6.2 Implement the registry keyed by SSH host fields + session name, with in-flight promise sharing, ping-before-reuse (5 s timeout) and ref-counted idle detach; verify unit tests for concurrent `getOrConnect`, stale-connection replacement and release-without-kill
- [x] 6.3 Hold `ref()` on the `SSHSession` for the connection's lifetime (through `tabbyAdapter.ts`); verify against the test host that closing unrelated SSH tabs to the same host keeps tomux connected

## 7. Window tabs

- [x] 7.1 Implement `TomuxPaneSession` (BaseSession): ported `send-keys` encoding with 1,024-byte chunks, `%output` → frontend, close on window close; verify ported encoding unit tests and, on the test host, that `echo a b  c`, `vim` arrow keys and a 100 KB paste arrive intact
- [x] 7.2 Implement binding (adopt / reopen / new) with the window ownership map, refusing to bind an owned window; verify unit tests for each intent including "restored window gone → tab closes" and "owned window → refused"
- [x] 7.3 Implement adoption display: `capture-pane` history and screen, cursor restore, live output buffered until the snapshot is written; verify on the test host that an adopted window with 2,000 lines of history shows it once and new output follows
- [x] 7.4 Implement resize (100 ms debounce, `refresh-client -C`) and `select-window` on tab focus; verify on the test host that dragging the window edge ends with `tput cols`/`lines` matching the tab
- [x] 7.5 Implement unclaimed-window tabs: the adoption queue after the startup grace period, plus `%window-add` with the barrier command; verify unit tests that our own `new-window` never produces a second tab, and on the test host that `tmux new-window` from another client opens one tab
- [x] 7.6 Implement close: kill only when marked by the close-intent service and still owner, tolerate errors, never kill if the wrapper is not installed; verify unit tests for each row of the design D6 cases and, on the test host, that closing Tabby keeps all windows while closing one tab kills only its window
- [x] 7.7 Port `windowTitle.ts` and wire `%window-renamed` → tab title and Tabby "Rename tab" → `rename-window`; verify ported title tests and, on the test host, the three rename scenarios in the `tmux-window-tabs` spec
- [x] 7.8 Make `TomuxTab.canClose()` skip the SSH "Disconnect?" prompt, and hide the inherited SSH UI decided in spike 2; verify by closing a tab without a dialog appearing
- [x] 7.9 Document in the README how tabs map to windows, what closing a tab does, and the single-pane limitation, and verify the README matches the behaviour seen in 7.1-7.8

## 8. Profile

- [x] 8.1 Implement `TomuxProfileProvider` and its settings component (SSH profile picker, session name defaulting to `main`, rejecting `.`, `:` and empty names); verify the profile can be created, edited and appears in Tabby's profile selector
- [x] 8.2 Implement `getNewTabParameters` with intent `new` and the missing-SSH-profile error; verify on the test host the three "Opening a tomux profile" scenarios and the deleted-SSH-profile error
- [x] 8.3 Verify that with a tomux profile set as Tabby's default, `+` and the new-tab hotkey open a new tmux window, also while a non-tomux tab is active, and document the setup in the README

## 9. Recovery

- [x] 9.1 Implement `getRecoveryToken()` (no `savedState`, `windowId` only with `includeState`, user-close tag for the closed-tab stack) and `TomuxRecoveryProvider` mapping tokens to adopt / reopen / new; verify unit tests for token shapes per Tabby flow
- [x] 9.2 Verify on the test host: three tabs, quit Tabby, reopen, and the same three windows come back in order with scrollback shown once; a window killed while Tabby was closed does not come back and no window is created; a window created elsewhere opens as an extra tab
- [x] 9.3 Verify on the test host that restoring eight tabs of a password-protected profile asks for the password once and leaves the session with the same number of windows
- [x] 9.4 Verify restart tab keeps the window, duplicate creates a new window, and reopen closed tab creates a new window in the same session; document restore behaviour and the main-window-only limit in the README

## 10. Integration and reliability checks

- [x] 10.1 Run a reliability pass on the test host and record results in `doc/TESTING.md`: laptop sleep/resume, network drop and reconnect, `yes | head -c 50M` heavy output, 10+ windows restored, two Tabby windows on the same session
- [x] 10.2 Build against the latest Tabby nightly and verify the plugin loads and spike checks 3.1 and 4.1-4.2 still pass; record the tested Tabby version in the README
- [x] 10.3 Run `openspec validate add-tomux-plugin --strict` and verify it passes

## Workflow follow-up

- Optionally offer Tabby the upstream one-line fix so `SplitTabComponent.destroy()` forwards `skipDestroyedEvent`, and a public "tab closed by user" signal; then simplify `closeIntent.service`.
- Archive the change after review.
