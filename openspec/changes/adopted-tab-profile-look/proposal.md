# Proposal

## Why

When tomux opens a tab for a tmux window no tab is bound to, the tab gets no tab colour, no icon and no title until tmux names the window. That covers the session's other windows when the profile is opened, and a window created later from inside tmux or another client. The tab the user opened from the profile has the profile's colour, icon and name, so only the first tab of a session is coloured. Users who colour profiles to tell hosts apart lose that on every other tab. Tabby saves each tab's own colour and restores exactly that, so a restart keeps those tabs uncoloured.

## What Changes

- A tab tomux opens for an unclaimed window, when a session connects or when a window appears later, shows the colour and icon of its tomux profile. Until the tab is first shown and tmux reports the window's name, it shows the profile's name. This is the look Tabby gives a tab opened from that profile. A profile without a colour or icon gives the tab none.
- Restored tabs keep the colour and icon saved with them, as today, including a colour the user picked from the tab menu.
- README: the extra tabs opened for a session's other windows get the profile's colour and icon.

Out of scope:
- Migrating tabs saved before this change. Tabby saves no colour for them, and a saved tab without a colour can't tell "the user chose no colour" from "opened before this change". Such a tab stays uncoloured after restarts until the user sets its colour once from the tab menu.
- Re-colouring open tabs when the profile's colour is edited. Tabby doesn't do that for any profile.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tomux-profile`: gains a requirement that tabs tomux opens on its own for a session's windows look like a tab opened from their tomux profile.

## Impact

- **Code**: `src/tomux.service.ts` (`prepareAdoptTab` adds the profile's look to the tab's inputs), `src/followActiveTab.ts` (the helper that works out a followed tab's look is now shared and renamed), `src/components/tomuxTab.component.ts` (uses the renamed helper), a new `src/tomux.service.spec.ts` (first unit tests of `TomuxService`).
- **Tabby APIs**: none new. The tab inputs `title`, `color` and `icon` are the ones Tabby's `ProfilesService.newTabParametersForProfile` sets for a tab opened from a profile.
- **Related change**: `plus-follows-active-tab` (complete, not archived) also adds a requirement to `tomux-profile`, about tabs opened with `+`. The two requirements don't overlap.
- **Docs**: README (extra tabs), `doc/TESTING.md` (manual check).
- **No new dependencies.**
