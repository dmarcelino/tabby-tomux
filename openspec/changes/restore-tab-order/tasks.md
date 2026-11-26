# Tasks

## 1. Read and write `@tomux-order` (design D2)

- [x] 1.1 Change `listWindows` in `src/tmux/controlClient.ts` to the format `id|index|pane|active|auto|order|name` and add `order: number | null` to `TmuxWindow` (null for an empty, negative or non-integer value). Update the fixtures in `controlClient.spec.ts`, `connection.spec.ts` and `fakeTmux.testing.ts`. Verify with new `controlClient.spec.ts` cases: a set order, an unset (empty) order, garbage (`abc`, `-1`, `1.5`) and a name containing `|`. `npm test` passes.
- [x] 1.2 Add `setWindowOrder(windowId, order)` (`set-option -w -t <id> @tomux-order <n>`, errors tolerated). Teach the fake tmux to store per-window options and report them in `list-windows`. Verify with a `controlClient.spec.ts` test for the exact command sent, and a fake-tmux round trip (set, then list).

## 2. One window order everywhere (design D3)

- [x] 2.1 Create `src/tabOrder.ts` (SPDX header) with `compareByRecordedOrder`: recorded order ascending, then windows without one, with ties by window number. Verify with `src/tabOrder.spec.ts` covering the tie, missing-order and all-missing cases.
- [x] 2.2 Use the comparator for the first bind in `decideBinding` and in `unclaimedWindows` (`src/binding.ts`). Verify with `binding.spec.ts`: the first bind picks the lowest-ordered unclaimed window, and with no orders still picks the lowest-numbered one (existing tests unchanged).

## 3. Adoption opens tabs in order (design D4)

- [x] 3.1 Add `openInOrder(ids, prepare, open)` to `src/tabOrder.ts`. It runs every `prepare` in parallel and calls `open` in the order of `ids` once all have settled, skipping any whose `prepare` rejected. Verify with a test whose preparations resolve in reverse order: `open` is still called in id order, and all `prepare` calls start before any finishes.
- [x] 3.2 In `src/tomux.service.ts`, split `openAdoptTab` into prepare (inputs) and open (zone + `openNewTab`). In `adoptLeftovers`, sort `plan.open` with `compareByRecordedOrder` (using the `list-windows` result) and open the tabs with `openInOrder` inside one `zone.run`. `onWindowAdd` still opens a single tab. Verify with `npm run typecheck` and `npm test`.

## 4. Record the tab order in tmux (design D5, D6)

- [x] 4.1 In `src/tabOrder.ts`, add a pure `planOrderWrites(barTabs, owned, written)`. It takes the tabs in bar order with split containers already flattened, the connection's window → owner pairs and the last written values, and returns the `(windowId, order)` pairs to send. Positions count only that connection's tabs. Verify with tests for a drag, a swap, another session's tab in between, a closed tab leaving a gap, a window whose owner is not in the bar (another Tabby window), and the no-change case (returns nothing).
- [x] 4.2 Add the sync to `TomuxService`: track the connections it sets up (dropping each when `closed` settles), add `orderReady` and `written` to `ConnectionState` (set or seeded at the end of `adoptLeftovers`), trigger on `app.tabsChanged$` (300 ms debounce) and on a 10 s interval, flatten `app.tabs` through `SplitTabComponent.getAllTabs()`, and send `setWindowOrder` for each planned write. Run it only when `BOOTSTRAP_DATA.isMainWindow` is true. Use only public tabby-core APIs, with nothing added to `src/tabbyAdapter.ts`. Verify with `npm run typecheck`, `npm test` and `npm run build` (no new warnings).
- [x] 4.3 Update the README as in design D6 ("Tabby's tab hotkeys" line and "Opening the profile" line). Verify that the README no longer says the first tab always takes the lowest-numbered window.

## 5. Check in a running Tabby against a real tmux

- [ ] 5.1 Drag a tab and use the move-tab hotkeys. Then run `tmux list-windows -F '#{window_id} #{window_index} #{@tomux-order}'` on the host and confirm that the values follow the tab bar within 5 s after a drag and within 15 s after a hotkey move and that the window numbers are unchanged. Record the result in `doc/TESTING.md`.
- [ ] 5.2 Reorder the tabs, turn off Tabby's tab restore (or clear its saved tabs), restart Tabby and open the profile. Confirm the tabs come back in the reordered order, and that a window created on the host while Tabby was closed opens last. Also restart with restore on and confirm the restored order is unchanged. Record the results in `doc/TESTING.md`.
- [ ] 5.3 On the oldest tmux available, check whether `set-option -w … @tomux-order` and `#{@tomux-order}` work. If they don't, confirm that tabs still open in window-number order with no errors shown to the user. Record the version and the result in `doc/TESTING.md`, and if the feature needs a newer tmux than 2.1, add that version to the README.
