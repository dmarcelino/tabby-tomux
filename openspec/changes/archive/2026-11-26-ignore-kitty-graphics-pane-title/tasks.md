# Tasks

## 1. Failing tests first

- [x] 1.1 In `src/tabTitle.spec.ts`, `describe('programTitleFromPane')`, add a test that `programTitleFromPane('Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA', 'testhost')` returns null. Add the other graphics commands from design decision 2 (`Ga=d,d=A`, `Gm=0;abc`, `Gf=100,a=T,m=1,z=-1;iVBOR`, `Ga=q,i=1`), also expecting null. Run `npm test` and check that these fail on the current code.
- [x] 1.2 In the same `describe`, add a test that titles close to the shape are returned unchanged: `Go away`, `GPU=1`, `Gx=1 build`, `Gx=1, y=2`. Check that it passes on the current code, and keeps passing after the fix.
- [x] 1.3 In `describe('TabTitleController: seeding from tmux')`, add a test where the pane's stored title is the query passed through `programTitleFromPane` (as the tab component does), and check that after `attach` to unnamed window 3 the tab shows `tmux:3`. Check that it fails on the current code.

## 2. Fix

- [x] 2.1 In `src/tabTitle.ts`, add the Kitty graphics pattern from design decision 2 as a module constant and make `programTitleFromPane` return null when the trimmed title matches it. Update the function's doc comment: tmux stores any APC sequence as the pane title, and xterm.js ignores them, so a live tab never showed it. Check that the tests from group 1 pass and no other test changes.

## 3. Integration

- [x] 3.1 Run `npm run typecheck`, `npm test` and `npm run build`. Check that all three pass and the build shows no new warnings.
- [x] 3.2 In the Tabby running on this machine (a test install; its session need not be preserved): link the plugin to this worktree, build, restart Tabby with `TOMUX_DEV=1`, and check that `log.txt` contains `tomux plugin loaded`. In an unnamed tomux window, run `printf '\033]2;fix login bug\007'` and then `printf '\033_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\033\\'`. Check that the tab still shows `fix login bug` and that `tmux display -p '#{pane_title}'` shows the query. Restart Tabby and check that the restored tab shows `tmux:<n>`, not the query. Do the restart once on the unfixed build first, to show the bug reproduces. Record the results in `doc/TESTING.md`. If any step can't be done in the session, say so in the final report and leave the task unticked.

## Workflow follow-up

- Archive the change after review, and sync the delta into `openspec/specs/tmux-window-tabs/spec.md`.
