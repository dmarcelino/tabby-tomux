## Context

Change `restore-tab-order` (archived 2026-11-26, design D5) made `TomuxService` record each window's tab position in `@tomux-order`, but only in the main Tabby window: `startOrderSync` returns early unless `isMainWindow()`, which reads `isMainWindow` from tabby-core's `BOOTSTRAP_DATA`. Its design accepted that "windows shown only in a secondary Tabby window keep their last `@tomux-order`".

In practice this means a session that the user only ever opens in a second Tabby window never gets an order at all, so every reopening falls back to window-number order. Confirmed on the user's host: session `personal` (used in a second window) had no value on any window, while session `main` (main window) had one on each.

Each Tabby window is its own renderer with its own `TomuxService`, its own connections and its own tab bar. When a second Tabby window connects to a session, adoption opens a tab there for every unclaimed window of that session, including windows the main window already shows (`doc/TESTING.md`, "Two Tabby windows on one session").

## Goals / Non-Goals

**Goals:**
- A session used in any Tabby window has its tab order remembered.
- Keep the rule easy to explain: "each Tabby window records the order of its own tabs; the last one to change it wins".

**Non-Goals:**
- Coordinating two Tabby windows (or two computers) that show the same session.
- Changing which tabs Tabby restores at startup.

## Decisions

### D1. Start the order sync in every Tabby window
`startOrderSync` keeps its `orderSync` guard (one sync per service) and drops the `isMainWindow()` condition. `isMainWindow`, the `mainWindow` field and the `BOOTSTRAP_DATA`/`BootstrapData` imports are deleted; nothing else uses them. Everything else in D5 of `restore-tab-order` stays as it is: the `orderReady` gate set after adoption, the `written` map seeded from `list-windows`, the triggers (`tabsChanged$`, `endBind`, the 10 s interval) and the pure `planOrderWrites`, which already numbers only the windows whose tab is in the tab bar it is given.

Alternatives:
- **Write only when this Tabby window shows every window of the session.** Rejected: adoption opens a tab for every unclaimed window in each Tabby window that connects, so a second window always shows the whole session and the check would never hold back a write.
- **Write only while this is the session's only control-mode client** (`list-clients -t <session> -F '#{client_control_mode}'`, or tracking `%client-session-changed`/`%client-detached`). It would stop two Tabby windows from overwriting each other, but costs a tmux round trip per sync (or extra notification handling), depends on which tmux versions report those formats, and is harder for a user to predict. The user chose last-writer-wins.
- **Let Tabby windows talk to each other** (for example `BroadcastChannel`) so only one writes per session. Rejected: it misses other computers, and relies on how Tabby runs its windows, which would have to live in `tabbyAdapter.ts`.

### D2. Two windows on one session cannot fight
Each Tabby window writes only when one of its own computed positions differs from its own `written` map (then the session's whole order, D3), and that map changes only through its own writes (plus the `list-windows` read at adoption). It never learns about the other window's writes, so a write by window B does not make window A write back. Window A writes again only when its own tab bar changes. That gives the spec's "the values written last stand".

Window A's tab bar also changes when window B closes or creates a tmux window (A's tab for it closes, or A adopts a tab for it), and when Tabby restores the main window's tabs at startup. A then writes its own order. That is still one write per change, never a loop, but the order that stands is A's, not the one the user last set in B. Accepted (see Risks) to keep the rule "a Tabby window records whenever its tabs change".

### D3. Write a session's whole order, not only the differences
`written` only knows this Tabby window's own writes, so a value it believes correct may have been changed by another Tabby window since. Sending only the values that differ would then leave a mix of both windows' orders, often with two windows at the same position (found in review: B drags `@3` to the front, writing `@3=0, @1=1, @2=2`; A then drags `@2` to the front and, against its stale `written`, sends only `@2=0, @1=1`, leaving `@2` and `@3` both at 0). `planOrderWrites` therefore returns nothing when every value matches `written`, and otherwise the value of every window of the connection whose tab is in the bar. A move then costs one write per tab of the session instead of one per moved tab; still no I/O when nothing changed.

Alternative: **re-read `@tomux-order` with `list-windows` before each write.** Rejected: a round trip per sync, and it fixes only the mix, not which order wins.

### D4. Test fakes
`tomux.service.spec.ts` builds the service with `BOOTSTRAP_DATA: { isMainWindow: false }` so that the sync stayed off, and its fake `AppService` has no `tabs` or `tabsChanged$`. With the sync starting everywhere, the fake gets `tabs: []` and a `tabsChanged$` subject, and the `BOOTSTRAP_DATA` entry goes. The new service test for the spec's "Second Tabby window" scenario puts adopted tabs in the fake tab bar, reorders them and checks the `set-option … @tomux-order` commands the fake tmux receives.

## Risks / Trade-offs

- [Two Tabby windows show the same session and the user reorders in both] → The last write wins, so `@tomux-order` may reflect the second window's order rather than the main window's. Either is a valid order. Tabby's own restore of the main window uses Tabby's saved tabs, not `@tomux-order`, so it is not affected; only tabs tomux opens itself (adoption, restore turned off, another computer) follow the value.
- [A second window adopts windows the main window shows, and their positions in the second window differ from the main window's values] → The second window writes its positions once after adoption, but only for values that differ. Adoption opens tabs in recorded order, so for windows that already had a dense order the positions match and nothing is written.
- [Window B closes or creates a tmux window that window A also shows] → Both Tabby windows' tab bars change, both record their order, and whichever syncs last wins. The user may lose the order they set in B. Documented in the README.
- [Tabby restarts after the user reordered a session in a second Tabby window that the main window also shows] → The main window restores its tabs in Tabby's saved order and records that order after adoption, replacing the second window's. Covered by the spec scenario "Tabby restarts after a reorder in a second Tabby window" and documented in the README. Sessions shown only in a second Tabby window, the case that motivated this change, are not affected.
- [The 10 s interval now runs in every Tabby window with a tomux connection] → It does no I/O unless an order changed, as before.
- [Quitting or closing a second Tabby window] → Same path as the main window: `closeWindow` → `closeAllTabs` destroys every tab in one synchronous loop, so the debounced sync sees an empty tab bar and writes nothing.

## Migration Plan

None. Sessions used in second Tabby windows get their values on the first sync after their next adoption. Rolling back leaves the values in place; they are read as before.
