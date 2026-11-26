# Proposal

## Why

After a normal Tabby restart, restored tomux tabs come back in their old order, because Tabby saves and restores its own tabs in tab-bar order. Whenever tomux opens tabs itself for a session's windows, the order is lost. That happens with tab restore turned off, after a fresh install or on another computer, and for windows that no restored tab claims. Those tabs open in tmux window-number order, which only matches the user's arrangement if they never moved a tab. And because each such tab waits on its own async preparation before it is added, even the window-number order is not guaranteed.

## What Changes

- tomux records the tab order in tmux. Each window of a session gets the tmux user option `@tomux-order`, set to its tab's position among that session's tomux tabs in the main Tabby window (0 is leftmost). tomux updates it when tabs are moved (drag, move-tab hotkeys), opened or closed. tmux window numbers stay as they are, so moving a tab still doesn't reorder windows in tmux.
- When tomux opens tabs for a session's unclaimed windows, it opens them in recorded order. Windows with no recorded order (created while Tabby was closed, or never shown by tomux) come after them, in window-number order.
- tomux prepares those tabs in parallel and then adds them to the tab bar one after another in that order. Their placement no longer depends on which preparation finishes first, and opening them takes no longer than today.
- When the profile is first opened on an existing session, the tab binds to the first window in recorded order instead of the lowest-numbered window. With no recorded order, it binds to the lowest-numbered window as before.
- Only the main Tabby window writes `@tomux-order`. tomux doesn't write it for a connection until that connection has opened its tabs for unclaimed windows, so a half-restored set of tabs can't overwrite the order it is about to read.
- README: explain `@tomux-order` next to "Moving a tab doesn't reorder windows in tmux", and update the "Opening the profile" line.

Out of scope:
- Placing tabs for unclaimed windows between restored tabs. They are still added after the restored tabs, in recorded order among themselves.
- Order across sessions. Each session's tabs are ordered within that session. Tabs of different sessions come in the order their connections finish adopting, as today.
- Windows created inside tmux while Tabby is open. They still get a new tab at the end of the bar.
- Secondary Tabby windows. Their tabs aren't restored (unchanged), and they don't write `@tomux-order`.
- Keeping tmux window numbers in sync with Tabby (`move-window`, `swap-window`). This was rejected because it changes window numbers other tmux clients see and conflicts with `renumber-windows` and `base-index`.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tmux-tab-recovery`: adds requirements that tomux records the tab order in tmux and opens tabs for unclaimed windows in that order.
- `tomux-profile`: "Opening a tomux profile opens a new window" binds the first tab to the first window in recorded order instead of always the lowest-numbered window.
- `tmux-window-tabs`: the "Reorder tabs" scenario says that tmux window numbers stay unchanged (the order is still recorded in `@tomux-order`).

## Impact

- **Code**: `src/tmux/controlClient.ts` (`listWindows` reads `@tomux-order`, plus a command that sets it), `src/tmux/fakeTmux.testing.ts`, `src/binding.ts` (first-bind choice), `src/tomux.service.ts` (adoption opens tabs in order, tab-order sync), a new pure module for ordering and rank diffs, and their unit tests.
- **Tabby APIs**: public only. `AppService.tabs` and `AppService.tabsChanged$`, `SplitTabComponent.getAllTabs()`, and the `BOOTSTRAP_DATA` token (`isMainWindow`). Nothing goes into `src/tabbyAdapter.ts`.
- **Tabby behaviour this relies on** (read in the installed tabby-core bundle): dragging a tab emits `tabsChanged$`, but the move-tab-left/right hotkeys (`swapTabs`) don't. Tabby itself only saves those within its 30-second recovery heartbeat, so tomux needs its own periodic check of the order.
- **tmux**: a window user option and a `#{@tomux-order}` format. Checked on tmux 3.6 (an unset option reads as empty). Not checked on the oldest supported tmux (2.1). If it doesn't work there, tomux falls back to window-number order, which is today's behaviour.
- **Docs**: README, `doc/TESTING.md` (manual checks).
- **No new dependencies.**
