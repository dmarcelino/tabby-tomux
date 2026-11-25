# Design

## Context

See proposal.md for the motivation.

How `+` reaches tomux (upstream Tabby source):

```
+ button / new-tab hotkey
  -> tabby-local TerminalService.openTab()              (buttonProvider.ts, index.ts)
       profile = config.store.terminal.profile           (the default profile)
  -> ProfilesService.openNewTabForProfile({...fullProfile, options})
  -> newTabParametersForProfile(profile)
       -> provider.getNewTabParameters(profile)          <- TomuxProfileProvider
       -> inputs.title = profile.name; color, icon, disableDynamicTitle copied
          from the profile when set                      (after tomux returns)
  -> AppService.openNewTab(params)
       -> TabsService.create: Object.assign(tab, inputs), then ngOnInit
```

- Every Tabby window is its own renderer with its own `AppService`, `TomuxService` and connection registry. A connection exists in a Tabby window only if one of its tabs opened it.
- The profile selector, profile hotkeys, the "recent profiles" entries and the command line also call `openNewTabForProfile(profile)`. Only the profile object tells the paths apart, and only through details the `+` path adds (`options.cwd`, `options.pauseAfterExit`).
- tabby-local's own `getNewTabParameters` already reads `app.activeTab` (and `SplitTabComponent.getFocusedTab()`) to give a new local shell the active tab's working directory. This change uses the same hook for the same idea.
- A tomux tab keeps the SSH profile (`profile`), the tomux profile (`tomuxProfile`) and the session it is pinned to (`sessionName`, from `tomuxSessionName` or the profile) for its whole life. Its connection key is built from the SSH profile and the session name.
- A tab bound to a window keeps a `bound` reservation for it while it is disconnected, so another tab of the same Tabby window does not take that window.

## Goals / Non-Goals

**Goals:**
- One decision, in public provider code, that picks which tomux profile, SSH profile and session a new tab uses.
- A followed tab reuses the active tab's connection when it has one, so the new tab runs `new-window` and nothing else opens.

**Non-Goals:**
- Telling `+` apart from the profile selector.
- Any change to how the binding rules (`decideBinding`, first-open adoption) work.
- Sharing anything between Tabby windows.

## Decisions

### D1. Follow only when the default profile is opened

`getNewTabParameters` follows the active tab only when `profile.id` equals `config.store.terminal.profile`.

- *Always follow when the active tab is a tomux tab*: rejected. Choosing profile X from the selector while on a tab of Y would open in Y.
- *An opt-in setting per profile*: rejected. It adds a setting to work around a quirk D1 already keeps small (choosing the default from the selector also follows).
- *Detect the `+` path from the `cwd`/`pauseAfterExit` keys it adds to `options`*: rejected. Undocumented, and it would stop working silently if tabby-local changes `openTab`.

The id comparison depends on the `+` path keeping the profile's `id`. tabby-local spreads the default profile's config proxy, whose properties are enumerable, so it does; task 3.1 confirms it in a running Tabby.

### D2. Decide in `TomuxProfileProvider.getNewTabParameters`

That is the only place every way of opening a tomux profile passes through, and it is public plugin API. Catching the `+` button or the `new-tab` hotkey directly would mean wrapping tabby-local internals.

The provider gathers the facts (requested profile id, default profile id, active tab or focused pane) and hands them to a pure function in a new module, `src/followActiveTab.ts`, which returns either "use the requested profile" or "follow this tab". The function is unit-tested without Angular. `AppService` and `ConfigService` are looked up lazily through the injector, as `TomuxService` already does, because `AppService` constructs tomux's providers (dependency cycle).

The active tab is `app.activeTab`; when that is a `SplitTabComponent`, its `getFocusedTab()`. Both are public tabby-core exports.

### D3. Copy the active tab's own profile objects and session

A followed tab gets the active tab's `profile` (SSH), `tomuxProfile` and `sessionName` (passed as `tomuxSessionName`) with a `{ kind: 'new' }` intent. They are not looked up again from the tomux profile id.

- This produces the same connection key as the active tab, so when that tab is connected `acquire` returns `opened: false` and the new tab creates a window.
- Looking the profiles up again would follow edits made since the tab opened (another SSH profile, another session name) and could open a different connection. The spec requires the session the tab is in.

A pure function in `src/followActiveTab.ts` builds these inputs from a tab, so it can be unit-tested; `TomuxTabInputs` in `src/tomux.service.ts` stays the one definition of the inputs and gains `tomuxFollowed`.

### D4. Follow whatever the connection state; fall back only on a profile error

The active tomux tab is followed whether it is connected, reconnecting or dropped. A tab that cannot connect anywhere is not followed, and `+` uses the requested profile as today. That is a tab:
- with `tomuxError` set (SSH profile missing when the tab was created, tomux profile missing after restore);
- whose session name `sessionNameError` rejects (the tab shows that error when it connects, not through `tomuxError`);
- whose tomux profile or SSH profile was deleted after the tab opened (`tomuxError` is set only at creation). The provider reads the profile ids from `ProfilesService.getProfiles()`, only when there is a tomux tab to follow.

- *Fall back while disconnected*: rejected. It brings back the reported problem in the very window the user is looking at, and adds a state check that matters only while a connection is down.
- While the active tab is reconnecting, the new tab's `acquire` joins the same attempt.
- When nothing is reconnecting, the new tab opens the connection itself (`opened: true`) and follows the first-open rule. The disconnected tab's `bound` reservation keeps its window from being taken.

### D5. Restore the followed profile's look in the tab

Tabby core sets `title` from the requested (default) profile and `color` and `icon` when that profile has them, after `getNewTabParameters` returns, so values set there are overwritten.

A followed tab therefore gets a new input, `tomuxFollowed: true`. In `ngOnInit` (inputs are assigned before it runs), such a tab sets `title`, `color` and `icon` from its `tomuxProfile` (`name`, `color || null`, `icon || null`; a profile config proxy reads an unset colour or icon as `''`, and Tabby treats any falsy value as none).

- *Apply the tomux profile's look in every tab's `ngOnInit`*: rejected. Restored tabs get their colour and icon from the recovery token, which keeps changes the user made in the tab menu.
- *Return inputs whose properties cannot be overwritten*: rejected. It fights Tabby's code instead of working with it.
- `disableDynamicTitle` needs nothing: tomux tabs always set it to `true` and read the user's setting from `tomuxProfile` (show-app-titles decision 5).

### D6. Tell Tabby's "Switch profile" apart from `+` in the new tab

Tabby's "Switch profile" (tab menu or hotkey) builds the replacement through `newTabParametersForProfile`, so `getNewTabParameters` runs while the tab being replaced is still the focused one. Picking the default profile there would follow that tab back into its own session, on a new window. Nothing in the call tells it apart from `+`: Tabby removes and destroys the old tab only after tomux returns.

So a followed tab also gets the followed tab, the split that held it, and the inputs for the profile that was asked for (`tomuxFollowedFrom`, `tomuxUnfollowed`). In `ngOnInit`, before the session name is pinned, the tab checks whether the followed tab is still in that split (`followedTabWasReplaced`). With `+` it is. With "Switch profile", Tabby has already put the new tab in its place (`SplitTabComponent.replaceTab`), so the tab takes the requested profile's inputs and opens on its session. Both references are dropped after the check.

- *Document the quirk*: rejected. The switch would leave the replaced tab's window running with no tab and open a new window in the same session, which looks like a lost window.
- *Wrap Tabby's context menu or `switchTabProfile`*: rejected. Internals, and the hotkey path would need the same.
- A tab that had no split when it was followed is never treated as replaced. Every Tabby tab sits in a split today.

## Risks / Trade-offs

- [Choosing the default profile from the selector, a profile hotkey, a recent-profile entry or the command line also follows the active tab] → Stated in the spec and README.
- [A followed tab leaves no trace of the tab it followed once that tab is gone] → The reference to the followed tab and the fallback inputs are dropped in `ngOnInit`, so a followed tab does not keep the old tab alive.
- [tabby-local's "New terminal" item in a tab menu calls `openTab()` and follows the *active* tab, not the tab whose menu was opened] → Same rule as `+`; acceptable. Noted in README only if the manual check shows it can happen with tomux tabs.
- [A future Tabby changes the `+` path so the profile loses its `id`] → `+` silently falls back to today's behaviour. Task 3.1 checks the current release; a unit test covers the decision for a missing id.
- [Pressing `+` on a non-tomux tab in a Tabby window that has no connection to the default session still opens a tab for each of that session's windows] → Out of scope (proposal); README says so.
- [A followed tab whose active tab's connection is gone may take an unclaimed window instead of creating one] → Existing first-open behaviour; reservations protect windows held by tabs.

## Migration Plan

None. No settings or stored data change. Users who want `+` to always go to the default session switch to a non-tomux tab first or choose another profile.
