# Tasks

## 1. Decision

- [x] 1.1 Add `src/followActiveTab.ts` with a pure function that takes the requested profile id, the default profile id (`terminal.profile`) and a description of the active tab or focused pane (not tomux / tomux with or without `tomuxError`), and returns "use the requested profile" or "follow this tab" (design D1, D4). Verify with unit tests in `src/followActiveTab.spec.ts` for: default requested + tomux tab → follow; other profile requested → requested; non-tomux tab → requested; no active tab → requested; tomux tab with `tomuxError` → requested; requested profile without `id` → requested; followed tab disconnected → follow

## 2. Wiring

- [x] 2.1 Add to `src/followActiveTab.ts` a pure function that builds the inputs for a tab that follows an existing tomux tab: its `profile`, `tomuxProfile` and `sessionName` (as `tomuxSessionName`), intent `{ kind: 'new' }` and `tomuxFollowed: true`, and add `tomuxFollowed?: boolean` to `TomuxTabInputs` (design D3, D5). Verify with a unit test that the inputs carry the tab's own objects and session, not values looked up again from the profile id
- [x] 2.2 In `TomuxProfileProvider.getNewTabParameters`, look up `AppService` and `ConfigService` lazily, find the active tomux tab (`app.activeTab` or, for a `SplitTabComponent`, its `getFocusedTab()`) through a pure function in `src/followActiveTab.ts`, call the function from 1.1, and return the inputs from 2.1 when it says to follow (design D2). tabby-core cannot be loaded in unit tests, so the provider stays thin wiring: verify with unit tests of the pure function for a tomux tab, a split with a focused tomux pane, a split with another pane, and a non-tomux active tab, and with `npm run typecheck`
- [x] 2.3 In `TomuxTabComponent.ngOnInit`, when `tomuxFollowed` is set, set `title`, `color` and `icon` from `tomuxProfile` (`name`, `color || null`, `icon || null`: a profile config proxy reads an unset colour or icon as `''`) before anything else uses them (design D5). Verify with a unit test of that step (extract it as a small function if the component cannot be instantiated in tests) for a profile with and without colour and icon
- [x] 2.4 Run `npm run typecheck`, `npm test` and `npm run build`, and verify all pass with no new build warnings

## 3. Running Tabby

- [x] 3.1 In a running Tabby against the test host, with a tomux default profile, check in DevTools (`TOMUX_DEV=1`) that the profile `getNewTabParameters` receives on `+` has the default profile's `id`. If it doesn't, stop and revisit design D1 with the user before continuing
- [x] 3.2 In a running Tabby against the test host, verify the spec scenarios of "Plus button and new-tab hotkey": non-tomux active tab; active tab of another tomux profile and session; second Tabby window showing only another session (exactly one new tab, none for the default session's windows); focused tomux pane of a split; disconnected active tab; session changed in the profile after the tab opened; active tab with a missing SSH profile; choosing another profile and the default profile from the selector. Check the tmux side with `tmux list-windows` and `tmux list-clients`. Also check whether a tab menu's "New terminal" on a tomux tab that isn't active can happen and what it does (design, Risks)
- [x] 3.3 In a running Tabby, verify the scenario "Default profile has a colour": the followed tab has `build-box`'s colour and icon (none) and shows `build-box` until tmux names it
- [x] 3.4 Record the results of 3.1–3.3 in `doc/TESTING.md`, including the Tabby version and OS, and state which checks were not run
- [x] 3.5 Update README Setup step 3: `+` and the new-tab hotkey add a window to the session of the active tomux tab, or the default profile's session when the active tab is not a tomux tab; choosing the default profile from the selector does the same; pressing `+` on a non-tomux tab in a Tabby window not connected to the default session still opens a tab for each of its windows. Verify the text matches the behaviour checked in 3.2

## 4. Integration

- [x] 4.1 Run `openspec validate plus-follows-active-tab --strict`, `npm run typecheck`, `npm test` and `npm run build`, and verify all pass and the build shows no new warnings

## 5. Review fixes

- [x] 5.1 Make `tabToFollow` also refuse a tab whose session name `sessionNameError` rejects, and a tab whose tomux profile or SSH profile no longer exists (the provider passes the ids `ProfilesService.getProfiles()` returns, looked up only when there is a tomux tab to follow) (design D4). Verify with unit tests for an invalid session name, a deleted tomux profile and a deleted SSH profile, and with `npm run typecheck`
- [x] 5.2 Add to the spec the scenarios "Active tab has an invalid session name", "Active tab's profile was deleted" and "Switching a tomux tab to the default profile". Verify with `openspec validate plus-follows-active-tab --strict`
- [x] 5.3 Make a followed tab open the requested profile when the tab it followed was replaced by Tabby's "Switch profile" (design D6): pass the followed tab, its split and the requested profile's inputs, and check in `ngOnInit` before the session name is pinned. Verify with unit tests of `followedTabWasReplaced` and the inputs, and with `npm run typecheck`
- [x] 5.4 In a running Tabby against the test host, check a deleted tomux profile, an invalid session name, Switch profile to the default (single tab and a split pane), and that `+`, `⌘-T` and `+` from a split pane still follow. Record the results in `doc/TESTING.md`
- [x] 5.5 Run `npm run typecheck`, `npm test` and `npm run build`, and verify all pass with no new build warnings

## Workflow follow-up

- Archive the change after review, so `tomux-profile` takes the modified requirement.
