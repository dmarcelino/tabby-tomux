# Design

## Context

See proposal.md for the motivation. The current state that shapes the approach:

- Tabby restores its saved tabs in tab-bar order, and tomux maps each recovery token back to its window (`src/recoveryProvider.ts`, `src/recoveryToken.ts`). That path stays as it is.
- Tabs for unclaimed windows come from two places in `src/tomux.service.ts`. `adoptLeftovers` runs once per connection, after a 2 s grace period and after restored tabs finish binding. `onWindowAdd` handles a window created while tabs are open. Both call `openAdoptTab`, which awaits `tabInputs()` (a `ProfilesService.getProfiles()` lookup) and then calls `app.openNewTab()`. Several tabs opened in one loop therefore reach `openNewTab` in whatever order their lookups resolve.
- `planAdoption` (`src/reservations.ts`) keeps the order of the window list it is given, and `list-windows` returns windows in number order.
- On a first bind, `decideBinding` (`src/binding.ts`) takes the lowest-numbered unclaimed window.
- `TmuxConnection` records which tab owns each window (`claim`/`ownerOf`). The owner is the `TomuxTabComponent` itself.
- `listWindows` (`src/tmux/controlClient.ts`) uses the format `id|index|pane|active|auto|name`, with the name last so that a `|` in a name can't shift the other fields.
- In the installed tabby-core: `AppService.addTabRaw`, `removeTab` and drag-reorder (`onTabsReordered`) emit `tabsChanged$`. The move-tab hotkeys go through `swapTabs`, and the `cycleTabs` wrap-around shifts `app.tabs` directly. Neither of those emits anything. Tabby only catches them with its own 30 s recovery heartbeat.
- `app.tabs` holds top-level tabs. `openNewTab` wraps each tomux tab in a `SplitTabComponent`, and `getAllTabs()` lists the tabs inside it.
- tmux 3.6 (checked locally): `set-option -w -t @0 @tomux-order 3` works, and `#{@tomux-order}` in `list-windows -F` expands to the value, or to an empty string when it is unset.

## Goals / Non-Goals

**Goals:**
- Tab order is stored on the tmux host, so it survives the loss of Tabby's saved tabs.
- When tomux opens tabs for a session's windows itself, it opens them in a fixed order.
- No extra round-trips before tabs open. Reordering a tab sends only the commands needed to update the windows whose position changed.

**Non-Goals:**
- Changing how Tabby's own restored tabs are placed.
- Placing new tabs in the middle of the tab bar (`openNewTab` always appends).
- Making `@tomux-order` meaningful to other tmux clients. It is tomux's private bookkeeping.

## Decisions

### D1. The order is stored in a per-window tmux user option, `@tomux-order`
The value is the tab's position (0-based, with no gaps) among the tomux tabs of the same connection key in the main Tabby window. Each window carries its own value, so the order moves with the window when it is renumbered, and it costs nothing to read with the existing `list-windows` call.

Alternatives:
- `move-window`/`swap-window` to make tmux window numbers follow the tabs. Rejected (see the proposal): other clients would see their windows renumbered, and it conflicts with `renumber-windows` and `base-index`.
- A single session option holding a list of window ids. Rejected: every move rewrites one shared value, and the value goes stale when windows are killed or created by other clients.
- Tabby's position across all tabs instead of a per-session position. Rejected: opening or closing a tab of an unrelated session would then rewrite every window.

### D2. `listWindows` reads the order, and a new client method writes it
The format becomes `id|index|pane|active|auto|order|name`, with the name still last. Its parts are now `slice(6)`. `TmuxWindow` gains `order: number | null`. Only a non-negative integer counts. Anything else, including the empty string an unset option gives and whatever an old tmux puts there, becomes `null`.

`setWindowOrder(windowId, n)` sends `set-option -w -t <id> @tomux-order <n>` with `CommandFlags.TolerateErrors`, so a tmux that refuses it only logs a warning. The fake tmux and the list-windows fixtures in `controlClient.spec.ts`, `connection.spec.ts` and `fakeTmux.testing.ts` move to the new field layout.

### D3. One comparator orders windows everywhere tomux picks them
A pure module (`src/tabOrder.ts`) exports `compareByRecordedOrder(a, b)`: windows with an order first, ascending; then windows without one; ties and the rest by window number. `decideBinding`'s first bind and `unclaimedWindows` use it, and `adoptLeftovers` sorts `plan.open` with it. The first tab and the extra tabs then agree on which window comes first.

### D4. Prepare in parallel, then open in order
`openAdoptTab` is split into two steps: preparing a tab's inputs (async) and opening it (sync, inside the Angular zone). `adoptLeftovers` runs `Promise.all` over the prepare step for all windows in sorted order, then opens them in that order inside one `zone.run`. `onWindowAdd` opens a single tab and keeps the two steps back to back. Preparation is a local profile lookup, so adoption is no slower than today. A small helper, `openInOrder(ids, prepare, open)`, takes this sequencing out of the service so it can be unit-tested with preparations that resolve out of order.

Alternative: call `tabInputs()` once and reuse the result for each window. Every adopted tab on a connection does use the same profile. But the inputs object is mutated per tab (`tomuxSessionName`, the intent), so it would need copying, and a later change that adds per-window inputs would break that silently. The parallel form gives the same latency without that coupling.

### D5. Order sync runs in `TomuxService`, in the main window only, after adoption
- **Main window only:** the service reads `isMainWindow` from tabby-core's public `BOOTSTRAP_DATA` token, looked up lazily through the injector like the other Tabby services. In other windows the sync never starts.
- **Gate:** `ConnectionState` gains an `orderReady` flag. `adoptLeftovers` sets it in a `finally` after it has opened its tabs (or found none to open), so a tab that fails to open doesn't switch the recording off. Each adopted tab opens on its own: `openInOrder` catches a failing preparation or `openNewTab`, opens the rest and returns the failures, which the service logs. If the `list-windows` call itself fails, the flag stays off for that connection and a warning says so. It also seeds a `written` map (window id → order) from the `list-windows` result it already has. Until the flag is set, the connection's windows are never written. This keeps a partly restored set of tabs from overwriting the order adoption is about to read.
- **Triggers:** `app.tabsChanged$` and the end of every bind (`endBind`, since a newly opened tab has no window yet when Tabby announces it), debounced by 300 ms, plus a 10 s interval. Events are handed to the debounce through `zone.runOutsideAngular`, because `debounceTime` starts its timer in whatever zone the event arrives in, and a timer inside Angular's zone would trigger change detection on every run. Hotkey moves don't emit `tabsChanged$` (see Context), so the interval catches them. Each run is a cheap in-memory comparison and sends nothing unless an order changed. Drags, opens and closes therefore reach tmux within the spec's 5 seconds, and hotkey moves within its 15 seconds. A 10 s interval is a third of Tabby's own 30 s recovery heartbeat, which is the only thing that saves hotkey moves in Tabby's own saved tabs.
- **Computation (pure, in `tabOrder.ts`):** flatten `app.tabs` (a `SplitTabComponent` contributes `getAllTabs()`) into a list of tab objects in bar order. For each live connection with `orderReady`, take its owned windows plus the windows reserved under its key (Tabby starts a tab's connection only when the tab is first shown, so restored and adopted background tabs hold their window only by reservation until then), keep those whose owner is in that list, sorted by the owner's position, and number them 0..n-1. Then diff against `written`, and return the `(windowId, order)` pairs to send. The service sends them and updates `written` straight away, so a failed command isn't retried in a loop. Windows that left the connection drop out of `written`.
- **Connections to visit:** the service keeps a `Set` of connections it set up and removes each one when its `closed` promise settles. It doesn't need to enumerate the registry.

A window gets written as soon as its tab owns or reserves it, so a tab that hasn't been shown yet keeps its place instead of the shown tabs being squeezed together. Windows that belong to tabs in other Tabby windows are never touched. Gaps left after a tab closes (its window is killed) are filled on the next run.

### D6. Docs
In the README, the "Tabby's tab hotkeys" line gets one sentence: tomux remembers the order in the window option `@tomux-order` and uses it when it opens tabs without Tabby's saved tabs. The "Opening the profile" line says the first window "in your last tab order (lowest-numbered when there is none)".

## Risks / Trade-offs

- [tmux 2.1 to 2.x may not support window user options or `#{@…}` in formats] → Values that can't be parsed become `null` and `set-option` errors are tolerated, so the behaviour falls back to today's number order. Task 5.3 checks the oldest tmux available. The README states the minimum version only if the check finds one.
- [Windows shown only in a secondary Tabby window keep their last `@tomux-order`, which can equal a value the main window gives another window] → Accepted: secondary windows are out of scope, and a tie is ordered by window number, so the worst case is those two windows in number order. Clearing or moving such values would mean writing to windows the main window doesn't show, which this change avoids.
- [Two Tabby installs (two computers) attached to the same session both write the order] → The last writer wins. Either result is a valid order, and a session shared between two Tabby windows was already out of scope.
- [Moving the first of many tabs rewrites every window of the session] → n short `set-option` commands on the control connection, sent once per change. That is acceptable for the tab counts tomux targets (tens). If it ever matters, the values can be made sparse later without changing the spec.
- [A 10 s interval runs for as long as the main window is open] → It does no I/O unless the order changed, and it only runs while there is at least one connection.
- [A user or script sets `@tomux-order` by hand] → It is read like any other value. Values that don't parse are ignored.
- [`cycleTabs` wrap-around and other direct writes to `app.tabs`] → The interval catches them as well.
- [Quitting Tabby destroys tabs one by one, so a sync in between could renumber the remaining tabs while the closed ones keep their old values] → tabby-core's `closeAllTabs` runs every `canClose()` first and then destroys all tabs in one synchronous loop. When the debounced sync runs, the tab bar is empty and nothing is written. The same holds for the `tabsChanged$` events of that loop. The sync also runs when a tab finishes binding (`endBind`), not only on `tabsChanged$`, because a newly opened tab has no window yet when Tabby announces it.

## Migration Plan

No migration. Windows with no `@tomux-order` sort as they do today, and the options are written the first time the main window syncs after its adoption pass. Rolling back leaves harmless user options on the host's windows.
