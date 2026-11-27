# Proposal

## Why

The tab order of a session used only in a second Tabby window is never remembered. Only the main Tabby window writes `@tomux-order` (`startOrderSync` returns early when `isMainWindow()` is false), so when the user reorders such a session's tabs, closes that Tabby window and opens the session's profile again, the tabs come back in window-number order. Observed on 2026-11-26: the windows of a session used in a second Tabby window, `personal` (`@112`, `@145`), had no `@tomux-order` at all, while the session in the main window, `main`, had a value on every window. Reopening `personal` after the user had dragged its second tab to the front brought back the old order.

The main-window-only rule was there to keep two Tabby windows that show the same session from overwriting each other's order. That was a weak protection: it already allowed Tabby on two computers to overwrite each other, and it cost every user of a second window their tab order.

## What Changes

- Every Tabby window records `@tomux-order` for the tomux tabs in its own tab bar, not only the main Tabby window. The rules for what is written are unchanged: a window's position among its session's tomux tabs in that Tabby window, 0 for the leftmost, written only after adoption has opened the session's tabs, and only when the value differs.
- When two Tabby windows show tabs for the same session, the last one to record wins, as already happens with Tabby on two computers. Each Tabby window only writes when its own tab order changes, so the two never overwrite each other in a loop.
- tomux no longer reads Tabby's `BOOTSTRAP_DATA` (it was used only to tell the main window apart), and the warning logged when Tabby did not provide it goes away.
- README: drop "Only the main Tabby window records it."

Out of scope:
- Detecting that another Tabby window or computer is attached to the same session and stopping writes then. Considered (tmux can count control-mode clients with `list-clients`) and rejected in favour of last-writer-wins, which is simpler to explain.
- Which tabs Tabby restores at startup (still the main window only, requirement "Scope of restore").

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tmux-tab-recovery`: "Tab order is recorded in tmux" changes from "tabs in the main Tabby window, other Tabby windows SHALL NOT write it" to "tabs in each Tabby window, last writer wins". Its "Second Tabby window" scenario is replaced.

## Impact

- **Code**: `src/tomux.service.ts` (`startOrderSync` no longer checks the window; `isMainWindow`, the `mainWindow` field and the `BOOTSTRAP_DATA` import are removed). `src/tabOrder.ts` is unchanged: `planOrderWrites` already only considers tabs in the tab bar it is given.
- **Tests**: `src/tomux.service.spec.ts` builds the service with `isMainWindow: false` and a fake `AppService` without `tabs` or `tabsChanged$`; the sync now starts in every window, so the fake needs both. A new service test covers a second-window tab order being written.
- **Tabby APIs**: one public token fewer (`BOOTSTRAP_DATA`). Nothing goes into `src/tabbyAdapter.ts`.
- **Docs**: README (tab hotkeys line), `doc/TESTING.md` (manual check in a second Tabby window).
- **No new dependencies.**
