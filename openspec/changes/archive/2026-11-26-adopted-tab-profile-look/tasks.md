# Tasks

## 1. Shared look helper

- [x] 1.1 Move `followedTabLook` from `src/followActiveTab.ts` to `src/profile.ts` as `profileTabLook`, with the same rules (`title` from `name`, `color || null`, `icon || null`), and use it in `TomuxTabComponent.ngOnInit` for followed tabs (design D3). Move its three tests from `src/followActiveTab.spec.ts` to a new `src/profile.spec.ts`. Verify that `npm test` passes and `grep -rn followedTabLook src` finds nothing

## 2. Adopted tabs

- [x] 2.1 Add `src/tomux.service.spec.ts`, which stubs `tabby-core` and runs a real `TomuxConnection` on `FakeTmux` through `acquire` (design D4), with tests for: two windows adopted when a connection opens, a window that appears later through `%window-add`, and a profile without colour or icon. Each test checks the `title`, `color` and `icon` inputs of the tabs passed to `AppService.openNewTab`. Verify the colour and icon tests fail before 2.2
- [x] 2.2 In `TomuxService.prepareAdoptTab`, add `profileTabLook(state.tomuxProfile)` to the inputs (design D1). Verify that the tests from 2.1 pass and that `npm run typecheck` passes
- [x] 2.3 README, "Opening the profile": say that the extra tabs, and the tab for a window created later, get the profile's colour and icon, and that a restored tab keeps the colour it had. Verify the text matches the spec scenarios in `specs/tomux-profile/spec.md`

## 3. Running Tabby

- [x] 3.1 In a running Tabby against the test host, with a tomux profile that has a colour and an icon, verify the spec scenarios: opening the profile on a session with two windows (both tabs coloured, with the icon); a window created inside tmux (coloured, profile name until tmux names it); a profile without a colour (no colour on either tab); a tab set to another colour from the tab menu keeps it after a restart. Record the results in `doc/TESTING.md` with the Tabby version and OS, and say which checks were not run

## 4. Integration

- [x] 4.1 Run `openspec validate adopted-tab-profile-look --strict`, `npm run typecheck`, `npm test` and `npm run build`, and verify all pass and the build shows no new warnings

## Workflow follow-up

- Archive the change after review, so `tomux-profile` takes the added requirement.
