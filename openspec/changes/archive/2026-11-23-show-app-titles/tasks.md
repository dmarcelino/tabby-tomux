# Tasks

## 1. Spike: confirm the assumptions on the test host

- [x] 1.1 In a tomux tab started with `TOMUX_DEV=1`, run `printf '\e]0;hello\a'` and verify from DevTools that the tab's `frontend.title$` emits `hello` (the OSC sequence arrives through `%output`). If it does not, stop and revisit design decision 1 before continuing
- [x] 1.2 On the test host, run `tmux display-message -p '#{pane_title}|#{host}'` in a fresh pane and after `printf '\e]0;hello\a'`, and verify the untitled value equals `#{host}` and the titled one is `hello`
- [x] 1.3 In Tabby, rename a tomux tab to `x`, then rename it to an empty name, and log `customTitle` on each `titleChange$` of the top-level tab; verify the user-cleared rename can be told apart from tomux's own `setCustomTitle('')`. If it cannot, ask the user whether to drop the empty-rename requirement before continuing
- [x] 1.4 Record the outcomes of 1.1-1.3 in design.md (decisions 1, 4, 6) and verify `openspec validate show-app-titles` passes

## 2. Title precedence

- [x] 2.1 Add `pickDisplayTitle({ windowName, windowIndex, programTitle, dynamicTitles })` (design decision 2) in a tomux-owned file with the SPDX header, and verify unit tests cover: user name wins, `tmux:<digits>` with a stale index counts as unnamed, program title shown when unnamed, empty program title falls back to `tmux:<index>`, toggle off ignores the program title
- [x] 2.2 Change the rename classification so program titles are not treated as window names tomux has shown (design decision 3), and verify unit tests: a Tabby rename to the program title currently shown is a user rename; a rename to anything but the current window name (including an earlier `tmux:<n>`, per the spec's "Rename back to the placeholder") is a user rename; echoes and two quick renames behave as before; the existing `windowTitle` and `titleEcho` tests still pass

## 3. Reading titles from tmux

- [x] 3.1 Add a control-client command that returns `#{pane_title}` and `#{host}` for a pane, and a helper that turns the pair into a program title or none (host name means none); verify unit tests against `fakeTmux.testing.ts`, including a pane title containing `|`

## 4. Tab wiring

- [x] 4.1 In `TomuxTabComponent`, keep the window name and program title as state (in `TabTitleController`, `src/tabTitle.ts`) and route every title update (`%window-renamed` via `shouldShowRename`, attach, Tabby rename) through `pickDisplayTitle`; verify the existing rename unit tests pass and `npm run typecheck` is clean
- [x] 4.2 Subscribe to `frontend.title$` (Tabby creates the frontend once, in `ngOnInit`) and update the program title; read the toggle from `tomuxProfile.disableDynamicTitle` (design decision 5) while keeping the class field `disableDynamicTitle = true`; verify no tmux command is sent when the program title changes (unit test on the extracted update logic, or a spy on the control client)
- [x] 4.3 Seed the program title from task 3.1 during `settleTitle` before the first title is shown, and again on `window-pane-changed` (replacing the old pane's title once read, design decision 4); verify with unit tests on the extracted logic that attach to a titled pane shows its title and an untitled pane shows `tmux:<index>`
- [x] 4.4 Update the Titles bullet in `README.md` (program titles shown while the window is unnamed, user names win, renaming to `tmux:<n>` makes the tab follow the program again, the "Disable dynamic tab title" toggle, the visible change for shells that set titles) and verify it matches the spec scenarios

## 5. Integration

- [x] 5.1 Run `npm run typecheck`, `npm test` and `npm run build`, and verify all pass with no new build warnings
- [x] 5.2 In a running Tabby against the test host, check: Claude Code titles an unnamed tab; a named tab keeps its name; Tabby rename to the shown title pins it; renaming the tab to `tmux:<n>` returns to the program title; reconnect and restart keep the title; a pane switch inside tmux switches the title; the profile toggle turns titles off, also for a window created inside tmux; a split shows both titles. Record the results in `doc/TESTING.md`

## 6. Code-review fixes

- [x] 6.1 Ignore titles from the old pane's output after a pane switch: the pane session writes `paneSwitchMarker(pane)` before the redraw, and titles before it are ignored (design decision 4); verify unit tests for a late old-pane title, a new-pane title winning over a slow read, a stale marker, and attach clearing the wait
- [x] 6.2 Make the Tabby-rename handler act only when the custom title changed, and clear an unedited OK in a split without renaming (`customTitleAction`, design decision 3); verify unit tests for unrelated split events, a split renamed while another pane is focused, and the joined-title OK
- [x] 6.3 Send the pinning rename before reading the pane title on attach (design decision 4); verify a unit test on the command order
- [x] 6.4 Replace the test host's name in fixtures and design.md with `testhost`; align the spec's wording with the placeholder name tmux has; record the toggle-refresh and renamed-host limitations in design.md; verify `openspec validate show-app-titles --strict` passes
- [x] 6.5 Run `npm run typecheck`, `npm test` and `npm run build`, and verify all pass with no new warnings
- [x] 6.6 In a running Tabby against the test host, retest: a pane switch while the old pane keeps printing titles; a split renamed while a non-tomux pane is focused keeps its name after "Split right"; an unedited OK in a two-pane tomux split renames nothing. Record the results in `doc/TESTING.md`
- [x] 6.7 File a GitHub issue for renames not reaching tmux after a tomux tab is moved to another split (pre-existing), and verify it has no host names or local paths

## Workflow follow-up

- Archive `add-tomux-plugin` before this change: this change's delta modifies a requirement that exists only once that change's specs are in `openspec/specs/`.
- Then archive `show-app-titles` and verify `openspec/specs/tmux-window-tabs/spec.md` contains the new requirements.
