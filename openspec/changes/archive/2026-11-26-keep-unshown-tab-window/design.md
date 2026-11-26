## Context

A tomux tab knows its window in two places: `windowId`, set when it binds, and `tomuxIntent` (`adopt @id`, `reopen @id` or `new`), set when it is created. A restored tab reserves its intent's window at once, so the window does not look unclaimed while the tab waits to be shown. `getRecoveryToken` reads only `windowId`, so a tab that has not bound yet saves a token without a window. `makeRecoveryToken` in `src/recoveryToken.ts` is a pure function, and `src/recoveryToken.spec.ts` covers it. That file even has a test that an unbound tab saves no window id, written with a `new` tab in mind.

See proposal.md for the bug and how it was found.

## Goals / Non-Goals

**Goals:**
- A tab saves the window it is bound to, or failing that the window its intent names.
- The rule lives in `makeRecoveryToken`, so unit tests cover it without a tab component.

**Non-Goals:**
- Recognising tokens that earlier builds saved without a window (see proposal, out of scope).
- Changing what a restored tab does when shown, or what closing it does to its window.

## Decisions

**1. The token's window is `windowId ?? the intent's window`.** `makeRecoveryToken` takes the tab's intent alongside `windowId`. With `includeState`, it writes `windowId` when the tab is bound, otherwise the intent's window for `adopt` and `reopen`, and none for `new`. `userClosed` is added as today whenever a window is written. The alternative, setting `windowId` from the intent when the tab is created, was rejected: `windowId` means "bound", and the close, reconnect and order code all rely on that.

**2. A saved intent window comes back as `adopt`, also for a `reopen` tab.** Without `userClosed`, `intentFromToken` already turns a window into `adopt`, and that stays. For an unshown `reopen` tab this means a restart restores it only if the window still exists, rather than creating a new window. That follows "Restore does not create stray windows". The alternative, saving a `reopen` marker, would let a restart create a window and needs a new token field.

**3. Bound wins over intent.** A bound tab's `windowId` can differ from its intent's window, for example a `reopen` tab that fell back to a new window, or a `new` tab. Using `windowId` first keeps every bound tab's token exactly as today.

## Risks / Trade-offs

- [A tab restored for a window that another tab took meanwhile saves that window too] → Two tokens can then name one window. On restore the second tab finds it owned and closes ("adopt": that window or nothing), which is today's handling of a token naming an owned window. No new window is created.
- [Tokens saved by earlier builds stay without a window] → Such tabs come back as `new` tabs once. The proposal states this, and `doc/TESTING.md` will say how to avoid it (show or close those tabs once).
