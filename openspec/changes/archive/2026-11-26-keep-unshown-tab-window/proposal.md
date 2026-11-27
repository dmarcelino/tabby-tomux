## Why

A restored tomux tab that is not shown before Tabby quits again loses its tmux window. Tabby connects a restored tab only when it is first shown, so until then the tab has no bound window. When Tabby saves its tabs, the tab writes a recovery token without a window id, and on the next start the tab comes back as a "new window" tab. Its window then opens a second time as an extra tab, and showing the old tab creates a new, empty tmux window. Anyone with more tabs than they look at between restarts hits this, and each restart adds another stray window.

It was found in a running Tabby against tmux 3.8 (recorded in `doc/TESTING.md`, "Branch claude-exit after merging main"): two tabs restored but never shown came back the next time as unbound tabs with a `new` intent, their windows `@136` and `@137` opened again as extra tabs, and showing one of the old tabs created window `@142`. Tabby's saved `tabsRecovery` showed the token of an unshown tab without `windowId`. The code involved, `getRecoveryToken` in `src/components/tomuxTab.component.ts`, has not changed since the first commit.

## What Changes

- A tomux tab that is not bound to a window yet saves the window it was restored or reopened for in its recovery token, so a tab never shown keeps its window across any number of restarts.
- That saved window is restored as `adopt` (that window, or the tab closes), as for a bound tab. A tab created to reopen a closed window and not yet shown also saves it as `adopt`, so a restart never creates a window for it.
- When the user closes such a tab, its token for Tabby's "reopen closed tab" carries the window with `userClosed`, as a bound tab's does. Reopening it binds that window if it still exists.
- Tokens for duplicate and split (no `includeState`) stay without a window. A tab opened for a new window and not yet bound saves no window, as today.

Out of scope:
- Tokens already saved without a window by an earlier build. They cannot be told apart from a duplicate's token, so such tabs still come back as "new window" tabs once. Closing those tabs, or showing each restored tab once before the next quit, avoids it.
- Whether closing a tab that never connected should kill its window. Today it does not, and this change keeps that.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-tab-recovery`: a new requirement, "A tab keeps its window until it is shown": a tab restored or reopened for a window keeps that window across restarts even if it was never shown, including when the window is gone by then and when the tab is closed and reopened.

## Impact

- Code: `src/recoveryToken.ts` (`makeRecoveryToken` takes the window from the tab's intent when the tab has no bound window) and `getRecoveryToken` in `src/components/tomuxTab.component.ts` (passes the intent).
- Tests: `src/recoveryToken.spec.ts`.
- No API, dependency or configuration changes. Bound tabs, duplicate, split and restart of a bound tab save the same tokens as today.
- `doc/TESTING.md` gets the result of the check in a running Tabby: restart twice without showing a restored tab.
