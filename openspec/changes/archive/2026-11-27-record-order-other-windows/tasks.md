## 1. Tests first

- [x] 1.1 In `src/tomux.service.spec.ts`, give the fake `AppService` a `tabs` array and a `tabsChanged$` subject, and drop the `BOOTSTRAP_DATA` entry; existing tests still pass
- [x] 1.2 Add a service test for the scenario "Second Tabby window": with `BOOTSTRAP_DATA` reporting a non-main window (or absent), after adoption and a reorder of the session's tabs in the fake tab bar, the fake tmux receives `set-option -w -t <id> @tomux-order <n>` with the new positions within 5 s of fake time; confirm it fails before 2.1
- [x] 1.3 Add a service test for the scenario "Two Tabby windows on one session": after this service has written its order, another client's change to `@tomux-order` (simulated in the fake tmux) is not overwritten by later syncs while this service's tab bar is unchanged (covers design D2)
- [x] 1.4 Remove or rewrite any test that asserts no writes in a non-main window (the old "Second Tabby window" scenario)
- [x] 1.5 Add a service test for the scenario "Reorder in both Tabby windows": after another client changed `@tomux-order`, a reorder in this service's tab bar leaves every window at this tab bar's position, with no two at the same value (design D3); confirm it fails with the differences-only `planOrderWrites`

## 2. Implementation

- [x] 2.1 In `src/tomux.service.ts`, drop the `isMainWindow()` check from `startOrderSync`, and delete `isMainWindow`, the `mainWindow` field and the `BOOTSTRAP_DATA`/`BootstrapData` imports
- [x] 2.2 Update comments that say the order is recorded by the main window only (`startOrderSync` doc comment, `tabOrder.ts` header)
- [x] 2.3 `planOrderWrites` returns every in-bar window's value when any differs from `written`, and nothing otherwise (design D3); update its unit tests

## 3. Docs

- [x] 3.1 README, "Tabby's tab hotkeys" line: replace "Only the main Tabby window records it." with sentences saying each Tabby window records the order of its own tabs whenever they change, the one that recorded last wins when two windows show the same session, and that this is not always the window the user reordered in (tmux windows opened or closed, Tabby restarting)

## 4. Verification

- [x] 4.1 `npm run typecheck`, `npm test` and `npm run build` pass with no new build warnings
- [x] 4.2 In a running Tabby against a real tmux: open a session's profile in a second Tabby window, drag its tabs into a new order, check `#{@tomux-order}` on the host, close that Tabby window, reopen the profile and check the tabs come back in the dragged order; record the results in `doc/TESTING.md`
