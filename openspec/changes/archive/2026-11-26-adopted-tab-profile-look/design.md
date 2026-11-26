# Design

## Context

See proposal.md for the motivation.

Where a tomux tab's title, colour and icon come from today (Tabby core 1.0.231 source, `tabby-core` package):

```
opened from the profile   ProfilesService.newTabParametersForProfile
                            -> inputs.title = profile.name; color, icon when set
                          -> AppService.openNewTab -> TabsService.create: Object.assign(tab, inputs)
followed by +             same path, then TomuxTabComponent.ngOnInit sets title, colour and icon
                          from tomuxProfile (plus-follows-active-tab D5)
restored                  TabRecoveryService.recoverTab, after TomuxRecoveryProvider.recover returns:
                            inputs.color = token.tabColor ?? null, icon and title likewise
adopted                   TomuxService.prepareAdoptTab -> tabInputs(): profile, tomuxProfile,
                          tomuxIntent, tomuxSessionName only
                          -> openAdoptTab -> AppService.openNewTab        (no title, colour or icon)
```

- Both adoption paths go through `prepareAdoptTab`: `adoptLeftovers` when a connection opens, and `onWindowAdd` when a window appears later.
- The tab bar draws `tab.color`. A split takes the colour of its focused pane, so the pane's input is what shows.
- Tabby saves `tab.color` and `tab.icon` in each tab's recovery token and restores exactly those values, so an adopted tab saved without a colour comes back without one.
- `TomuxService` has no unit tests. It imports `AppService`, `ProfilesService`, `SplitTabComponent` and `BOOTSTRAP_DATA` from `tabby-core` at runtime, and that package doesn't load under Node.

## Goals / Non-Goals

**Goals:**
- An adopted tab gets the look Tabby gives a tab opened from the same profile, from one rule shared with followed tabs.
- Tests that fail without the fix, driven through `TomuxService` itself, not just through the helper.

**Non-Goals:**
- Any change to restored tabs, recovery tokens or the order in which tabs open.

## Decisions

### D1. Set the look in the adoption inputs

`prepareAdoptTab` adds `title`, `color` and `icon` from the connection's tomux profile to the inputs it builds. `openAdoptTab` passes them to `AppService.openNewTab`, and `TabsService.create` assigns them before `ngOnInit`, as for a tab opened from a profile. Nothing in Tabby overwrites them afterwards, unlike the `+` path.

- *Flag adopted tabs and set the look in `ngOnInit`, as followed tabs do*: rejected. It adds an input and a code path for no gain, because nothing overwrites these inputs.
- *Set the look in every tab's `ngOnInit`*: rejected, as in plus-follows-active-tab D5. It would replace the colour a restored tab keeps from the tab menu.

### D2. Leave restored tabs as Tabby restores them

Tabby sets a restored tab's colour from its token after `TomuxRecoveryProvider.recover` returns. A token with no colour may come from an adopted tab saved before this change, or from a tab whose colour the user removed in the tab menu. Nothing tells the two apart.

- *Mark tokens written after this change, and give unmarked tokens the profile's look once*: rejected. It needs a new token field plus a path in `ngOnInit`, since Tabby overwrites the inputs, to fix a leftover the user clears once from the tab menu.

### D3. One helper for the look of a tab opened for a tomux profile

`followedTabLook` (in `followActiveTab.ts`) becomes `profileTabLook` in `profile.ts`, next to the `TomuxProfile` type, with the same rules: `title` from `name`, `color || null`, `icon || null`. A profile config proxy reads an unset colour or icon as `''`, and Tabby treats any falsy value as none. Followed tabs and adopted tabs both use it, and its tests move to `profile.spec.ts`. `profile.ts` imports only types, so the service and the component can both use it without loading Tabby.

### D4. Test `TomuxService` with `tabby-core` stubbed

`src/tomux.service.spec.ts` replaces `tabby-core` with `vi.mock` (empty classes for the services and components it imports, a token for `BOOTSTRAP_DATA`). It builds the service with an injector that returns a fake `AppService`, which records `openNewTab` calls, a fake `ProfilesService` and an `NgZone` stand-in that runs callbacks directly. The connection is a real `TomuxConnection` on `FakeTmux`, opened through `acquire`:
- adoption when a connection opens: `FakeTmux` lists two windows; after the grace period, under fake timers, each recorded tab has the profile's title, colour and icon;
- a window appearing later: a `%window-add` notification opens one tab with the same look;
- a profile without colour or icon: the tabs get `null` for both.

`BOOTSTRAP_DATA` resolves to "not the main window", so the tab-order sync stays off and the test is about adoption alone.

## Risks / Trade-offs

- [Tabs saved before this change stay uncoloured after restarts] → Set the colour once from the tab menu; the proposal lists this under "Out of scope".
- [The connection's tomux profile is the one the first tab opened with] → Every tab of a connection shares its tomux profile, because the connection key comes from the SSH profile and session, so the look matches the tab that opened it. Two tomux profiles that point at the same SSH profile and session share one connection: adopted tabs take the look of whichever profile connected first. The same is true today for their session and settings.
- [The stubbed `tabby-core` can drift from the real one] → The stub supplies only the names `tomux.service.ts` imports. A new import that the stub lacks makes vitest throw a missing-export error when the service uses it, and the test fails.
