# Proposal

## Why

`+` always opens the default profile's session, whichever tab is active. In a second Tabby window that shows another session, `+` connects that window to the default session for the first time, so tomux opens a tab there for every window of that session: the tabs of the other Tabby window appear where the user only wanted one new window. Tabby itself already makes `+` follow the active tab (a local shell inherits the active tab's working directory), so users expect `+` to stay in the session they are looking at.

## What Changes

- When the profile Tabby opens is the configured default profile ("Default profile for new tabs") and the active tab, or the focused pane of a split, is a tomux tab, `+` and the new-tab hotkey create a new tmux window in that tab's host and session instead of the default profile's.
- The new tab uses the session the active tab is in, even if that tab's tomux profile was edited since.
- The active tab is followed whatever its connection state (connected, reconnecting or dropped). The only tomux tab that is not followed is one that shows an error because it cannot connect anywhere (missing SSH or tomux profile); `+` then uses the default profile as today.
- A non-tomux active tab keeps today's behaviour.
- Choosing a profile other than the default from the profile selector is not affected. Choosing the default profile itself through the selector, a profile hotkey or the command line follows the active tab too, because Tabby passes it to tomux the same way as `+`.
- A tab opened this way shows the title, colour and icon of the tomux profile it opened on, not those of the default profile.
- README: replace "`+` always goes to that host, whichever tab is active".

Out of scope:
- A separate hotkey or tab-menu item for "New tmux window in this session", for users whose default profile is not a tomux profile (a follow-up change).
- Pressing `+` while a non-tomux tab is active in a Tabby window that has no connection to the default session still opens a tab for each of that session's windows (first-open rule in `tomux-profile`). Avoiding that needs Tabby windows to share connection state, which they don't.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tomux-profile`: "Plus button and new-tab hotkey" changes from "whichever tab is active" to following the active tomux tab when the default profile is opened, and gains a requirement that such a tab looks like a tab of its own profile.

## Impact

- **Code**: `src/profileProvider.ts` (`getNewTabParameters` decides which tomux profile, SSH profile and session to use), a new pure module for that decision with unit tests, `src/components/tomuxTab.component.ts` (title, colour and icon of a tab that followed the active tab), `src/tomux.service.ts` (`TomuxTabInputs` gains a field).
- **Tabby APIs**: public only: `AppService.activeTab`, `SplitTabComponent.getFocusedTab()` and `ConfigService` (`terminal.profile`, the default profile id). Nothing goes into `src/tabbyAdapter.ts`.
- **Depends on** Tabby's `+` path (tabby-local `TerminalService.openTab`) passing the default profile with its `id`. Read in upstream source; to be confirmed in a running Tabby.
- **Docs**: README (default profile paragraph), `doc/TESTING.md` (manual checks).
- **No new dependencies.**
