# Tasks

## 1. Spike: SFTP panel created in code

- [x] 1.1 In a throwaway branch of `TomuxTabComponent`, add an `<ng-container #sftpHost>` and on a button click create tabby-ssh's `SFTPPanelComponent` there with `createComponent` and `setInput` (`session` = `sshSession`, `path` = `/`, `cwdDetectionAvailable` = `true`). Verify in a running Tabby (1.0.238 or newer) against the test host that the panel lists files, navigates, opens its context menu and closes through its own close button, with no errors in DevTools (upload and download use native dialogs and moved to 3.4)
- [x] 1.2 Check whether the `panelSlide` animation can be played on the created host element with little code, and compare the SSH tab's toolbar and `sftp-panel` markup and SCSS in upstream Tabby (the release we target) with what design T1/T2 assumes. Verify by noting the outcome in design.md T1/T2. If 1.1 failed, stop and revisit T2 with the user before continuing

## 2. Working directory from tmux

- [x] 2.1 Add `TmuxControlClient.paneCurrentPath(paneId)` (`display-message -p -t <pane> "#{pane_current_path}"`, trimmed, `null` when empty), and verify with unit tests against `fakeTmux` for a normal path, a path with spaces, an empty reply and a tmux error
- [x] 2.2 Make `TomuxPaneSession.supportsWorkingDirectory()` return whether the connection is live and `getWorkingDirectory()` return the pane's path, or `null` on error or after the connection ended. Verify with unit tests for live, ended and failing connections

## 3. Toolbar and SFTP panel

- [x] 3.1 Add to `src/tabbyAdapter.ts` the helper that creates `SFTPPanelComponent` in a `ViewContainerRef` (inputs, `pathChange`/`closed` wiring, `bg-dark`, click propagation stopped, position styles) and returns a handle to destroy it. Treat a missing `SFTPPanelComponent` export as non-fatal and log a warning, and extend the adapter's header comment with the `@hidden` members from design T6. Verify with `npm run typecheck` and a unit test of the missing-export path
- [x] 3.2 Replace the tab's template with the base template + the `<terminal-toolbar [tab]="this">` block from design T1 (dot, `user@host:port` + session name label, Reconnect, SFTP, Ports with the SSH tab's conditions; no working-directory tip) + `<ng-container #sftpHost>` + the existing keyboard-interactive panel, and set `enableToolbar = true`. Add a comment naming the upstream file the block was copied from. Verify with `npm run build` with no new warnings
- [x] 3.3 Turn `sftpPanelVisible` into an accessor that creates the panel through the adapter helper when set to `true` with an `sshSession` and a ready view, destroys it when set to `false`, and also destroys it when the tab is destroyed or its session closes. Hide the SFTP button when the adapter reported the export missing. Verify with unit tests of the accessor logic (no view yet, no SSH session, open, close, open twice) using a stub helper
- [x] 3.4 In a running Tabby against the test host, verify the spec scenarios for the toolbar (connected, disconnected, pin/unpin, label) and SFTP (toolbar button, tab menu "Open SFTP panel", `open-sftp` hotkey, starts in the folder after `cd /var/log`, close button and terminal click close it, the file list scrolls in a long folder such as `/usr/bin`, upload and download one file, the tmux window gets no input), plus "Copy current path" in the tab menu. Record the results in `doc/TESTING.md`
- [x] 3.5 Update README "How it works" with the toolbar, SFTP (opens in the pane's current folder) and "Copy current path", and verify the README matches the behaviour checked in 3.4

## 4. Ports and Reconnect

- [x] 4.1 Add a unit test showing that a tab reconnecting with a `windowId` binds with an `adopt` intent for the same window and closes, rather than creating a window, when that window is gone (`decideBinding`). Verify `npm test` passes
- [ ] 4.2 In a running Tabby against the test host, verify the spec scenarios for Ports (add a local forward and reach it, see it from a second tomux tab of the same session, a profile's forwarded ports are active and listed) and Reconnect (while connected: same window redrawn with history and other tabs uninterrupted; after a dropped connection: reconnects to the same window; window killed while disconnected: the tab closes and no window is created; Reconnect after typing `exit` in a nested shell and with the profile set to close on session end keeps the tab; a double-click on Reconnect leaves one tmux client attached and closing every tab detaches it; with "clear service messages on connect" off the history appears once; after a drop the pinned toolbar turns red without other input). Record the results in `doc/TESTING.md`
- [ ] 4.3 Add to README "How it works" that port forwards belong to the host's SSH connection and are shared by every tab using it, and say what Reconnect does in a tomux tab. Verify against the behaviour checked in 4.2

## 5. Integration

- [x] 5.1 Update `add-tomux-plugin` design D3's "the SSH toolbar is simply absent" note to point to this change, and verify `openspec validate add-ssh-toolbar` and `openspec validate add-tomux-plugin` pass
- [x] 5.2 Run `npm run typecheck`, `npm test` and `npm run build`, and verify all pass and the build shows no new warnings

## Workflow follow-up

- Archive after `add-tomux-plugin` is archived, so `tmux-tab-ssh-tools` lands next to the capabilities it builds on.
