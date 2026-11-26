# Tasks

## 1. Save the intent's window in the token

- [x] 1.1 In `src/recoveryToken.ts`, give `makeRecoveryToken` the tab's intent and write `windowId ?? the intent's window` (none for `new`) when `includeState` is set, with `userClosed` as today (design decisions 1 to 3). Update the header comment. Verify with `src/recoveryToken.spec.ts` tests: an unbound `adopt` tab saves its window and restores as `adopt`; an unbound `reopen` tab saves its window and restores as `adopt`; an unbound tab closed by the user restores as `reopen` of that window; an unbound `new` tab still saves none (the existing test, renamed to say `new`); a bound tab whose intent names another window saves its bound window; no `includeState` saves none whatever the intent
- [x] 1.2 In `getRecoveryToken` in `src/components/tomuxTab.component.ts`, pass `this.tomuxIntent`. Verify with `npm run typecheck`

## 2. Checks

- [x] 2.1 Run `npm run typecheck`, `npm test` and `npm run build` and verify they pass with no new build warnings; run `openspec validate keep-unshown-tab-window --strict` and verify it passes
- [x] 2.2 In a running Tabby against a real tmux, check the spec's scenarios: quit and restart twice without showing a restored tab (same tabs, no extra tab, no new window, the tab binds its window when shown), kill that window while Tabby is closed (the tab does not come back, no new window), and close an unshown restored tab then reopen it (bound to its window). Check Tabby's saved `tabsRecovery` has the window id for the unshown tab. Record the results in `doc/TESTING.md`, with the note that tabs saved by an earlier build come back as new tabs once, or say which could not be run

## Workflow follow-up

- Archive the change once it is merged and the Tabby checks are recorded.
