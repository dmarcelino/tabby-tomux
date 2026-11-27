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
Each Tabby window sends a value only when its own computed position differs from its own `written` map, and that map changes only through its own writes (plus the `list-windows` read at adoption). It never learns about the other window's writes, so a write by window B does not make window A write back. Window A writes again only when its own tab bar changes. That gives the spec's "the value written last stands".

### D3. Test fakes
`tomux.service.spec.ts` builds the service with `BOOTSTRAP_DATA: { isMainWindow: false }` so that the sync stayed off, and its fake `AppService` has no `tabs` or `tabsChanged$`. With the sync starting everywhere, the fake gets `tabs: []` and a `tabsChanged$` subject, and the `BOOTSTRAP_DATA` entry goes. The new service test for the spec's "Second Tabby window" scenario puts adopted tabs in the fake tab bar, reorders them and checks the `set-option … @tomux-order` commands the fake tmux receives.

## Risks / Trade-offs

- [Two Tabby windows show the same session and the user reorders in both] → The last write wins, so `@tomux-order` may reflect the second window's order rather than the main window's. Either is a valid order. Tabby's own restore of the main window uses Tabby's saved tabs, not `@tomux-order`, so it is not affected; only tabs tomux opens itself (adoption, restore turned off, another computer) follow the value.
- [A second window adopts windows the main window shows, and their positions in the second window differ from the main window's values] → The second window writes its positions once after adoption, but only for values that differ. Adoption opens tabs in recorded order, so for windows that already had a dense order the positions match and nothing is written.
- [The 10 s interval now runs in every Tabby window with a tomux connection] → It does no I/O unless an order changed, as before.
- [Quitting or closing a second Tabby window] → Same path as the main window: `closeWindow` → `closeAllTabs` destroys every tab in one synchronous loop, so the debounced sync sees an empty tab bar and writes nothing.

## Migration Plan

None. Sessions used in second Tabby windows get their values on the first sync after their next adoption. Rolling back leaves the values in place; they are read as before.
