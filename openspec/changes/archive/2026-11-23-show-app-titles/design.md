# Design

## Context

See `proposal.md` for the motivation and `specs/tmux-window-tabs/spec.md` for the required behaviour.

Today (design D9 of `add-tomux-plugin`):

```
 program --OSC 0/2--> pane pty --> tmux
                                    |-- sets #{pane_title} (window name unchanged)
                                    '-- %output, raw pty bytes, OSC included
                                          |
                     PaneOutputNormalizer (strips \ek, DSR/DA, OSC 10/11 only)
                                          v
                     xterm.js onTitleChange --> frontend.title$
                                          v
                     BaseTerminalTabComponent: if (!disableDynamicTitle) setTitle()
                     TomuxTabComponent sets disableDynamicTitle = true  --> dropped
```

The tab title comes only from `%window-renamed` and from `settleTitle`, which pins an automatically named window to `tmux:<index>` with `automatic-rename off` + `rename-window`. `TabTitleSync` tracks renames tomux sent so their echoes are recognised, and classifies Tabby's custom title so only real user renames are pushed to tmux.

Tabby APIs involved, all public: `frontendReady$` and `frontend.title$` (`tabby-terminal`), `disableDynamicTitle` on profiles and tabs (`tabby-core`).

## Goals / Non-Goals

**Goals:**
- One pure function decides the tab title from the window name, the program title and the toggle, so the precedence is unit-tested without Tabby.
- Program titles never cause tmux traffic.
- The existing rename sync (echoes, two quick renames, splits) keeps its behaviour.

**Non-Goals:**
- Showing titles from panes other than the window's active pane.
- Handling an OSC sequence split across two `%output` chunks specially. xterm.js parses its input statefully, so this already works; only `PaneOutputNormalizer` has that limitation, and it does not touch OSC 0/2.

## Decisions

### 1. Take the program title from `frontend.title$`, not from tmux notifications

The OSC bytes already reach xterm.js, which parses them. tomux subscribes to `frontend.title$` each time `frontendReady$` fires and keeps the latest value as `programTitle`.

Spike (task 1.1): on the test host (tmux 3.5a), `printf` of OSC 0 (BEL) and OSC 2 (ST) in a tomux tab made `frontend.title$` emit both titles while the tab stayed `tmux:15`. A local tmux 3.8 control client showed the same bytes in `%output` and the window name unchanged.

- *Alternative: tmux subscriptions* (`refresh-client -B` on `#{pane_title}`, tmux 3.2+). Works for any client and survives pane switches, but raises the tmux version floor, adds a per-window subscription and a round trip per change. Rejected for live updates; `#{pane_title}` is still read on attach (decision 4).

### 2. Precedence as a pure function

```
pickDisplayTitle({ windowName, windowIndex, programTitle, dynamicTitles }):
  if windowName is set and not /^tmux:\d+$/   -> windowName      (user's name)
  if dynamicTitles and programTitle non-empty -> programTitle
  else                                        -> `tmux:${windowIndex}`
```

It lives in a new tomux-only file, `src/tabTitle.ts`, since `windowTitle.ts` is a port. A placeholder name is shown as tmux has it (`tmux:7` stays `tmux:7` after renumbering), as before this change; `tmux:<index>` is the fallback only when no name is known. The tab recomputes the title whenever any input changes: `%window-renamed`, a new program title, a pane switch, or attach. `emitTitle` already deduplicates.

- *Why match `tmux:<digits>`, not exactly `tmux:<current index>`:* indexes change when windows are renumbered (`renumber-windows`), and a stale `tmux:3` on window 2 is still tomux's placeholder, not a user name.
- *Alternative: remember in a tmux user option (`@tomux-named`) whether the user named the window.* Exact, but it costs a command per rename and on attach, and windows named by another tmux client would have no marker. Rejected; a user who names a window `tmux:7` on purpose is not worth that.

### 3. Rename handling with program titles in the mix

`TabTitleSync.recordEmission` adds every title it emits to `knownTitles`, and `classifyTerminalName` ignores Tabby custom titles that are known or equal to the last emission. If program titles went through the same path, renaming the tab to the program title it currently shows would be ignored. The spec requires that rename to pin it (scenario "Rename in Tabby to the shown program title"), and renaming back to an earlier `tmux:<n>` to unpin the window (scenario "Rename back to the placeholder").

So all title state moves into one class, `TabTitleController` (`src/tabTitle.ts`), which the tab component only feeds with events:
- `TabTitleSync` tracks window names only. Program titles never reach it.
- A Tabby custom title is a user rename unless it equals the current window name. The "settling" classification is no longer used by tomux: it guards against VS Code applying titles late, and Tabby only sets a custom title when the user renames. A custom title equal to the window name is cleared without a command.
- Tabby's `titleChange$` is `distinctUntilChanged`, so a custom title equal to the title already shown (the user confirming a shown program title) never reaches it. The rename handler also listens to `recoveryStateChangedHint$`, which `setCustomTitle` always pings. Found in the live test (task 5.2).
- That hint also fires for unrelated split events (adding, replacing or pinning tabs). So the handler acts only when the custom title changed since it last looked (`customTitleAction`, review fix). A name a split keeps on purpose, because another pane was focused when it was given, is never pushed to tmux by a later event.
- In a split, Tabby's rename dialog is pre-filled with the joined pane titles (`right job | left job`). Confirming it unedited clears the custom title without renaming any window (review fix). In a lone tab, confirming the shown title still pins it.
- Echo handling (`shouldShowRename`, pending renames) is unchanged; an accepted `%window-renamed` updates the window name and the title is recomputed.

### 4. Seeding from `#{pane_title}`

`capture-pane` history has no OSC sequences, so after attach or a pane switch the tab has no program title. tomux reads `#{pane_title}` and `#{host}` for the active pane (one `display-message -p -t <pane>` call, or extra fields in `list-windows`) and uses the pane title unless it equals the host name, which is what tmux sets on a pane no program has titled.

Spike (task 1.2): an untitled pane's `#{pane_title}` equals `#{host}` (the test host's name on tmux 3.5a; the full `<name>.local`, not `#{host_short}`, on a local tmux 3.8). After OSC 0/2 it holds the title; after an empty OSC title it is empty, which also means "no program title".

- On attach this goes into the existing `settleTitle` step, before the first title is shown, so the tab does not flash `tmux:<n>`. The rename that pins an automatic name to `tmux:<n>` is sent before the read, not after it, because it is decided from the window list read during bind: a user rename landing during an extra round trip would be overwritten (review fix).
- On `window-pane-changed` the tab reads the new pane's title and replaces `programTitle` with it once it arrives, so the old title does not flash to `tmux:<n>` first. Only the latest attach or pane switch applies.
- xterm.js parses written output later, on a timer. A title the old pane printed just before the switch can therefore reach `title$` after tomux learned about the switch, and would both show the old pane's title and discard the read. So the pane session writes a private marker, an OSC 2 title `tomux-pane-switch <pane>`, right before it redraws the new pane (`paneSwitchMarker`). Until xterm parses that marker, titles are ignored as the old pane's. After it, a title from the new pane wins over a read still in flight. The marker is never shown, and Tabby's own title handler is off for tomux tabs (decision 5), so nothing else sees it. Review fix; an attach stops waiting for a marker, since a new connection's pane session has none pending.
- Program titles arriving through `title$` after attach overwrite the seed.

### 5. The toggle

The class keeps `disableDynamicTitle = true` so Tabby's own handler never sets the title behind tomux's back. Whether program titles are shown is read from the tomux profile: `tomuxProfile.disableDynamicTitle` (Tabby's profile option, default `false`). It is read from the profile, not from the tab input, because tabs that `TomuxService` opens for windows created inside tmux do not go through `ProfilesService`, which is what copies the option into tab inputs. No default is added to `configDefaults`; Tabby's own profile defaults cover it.

### 6. No empty rename; `tmux:<n>` is the reset

Spike (task 1.3), from Tabby's source: the rename dialog accepts an empty name and calls `setCustomTitle('')`, but tomux has already cleared the custom title after the previous rename, so the displayed title does not change and `titleChange$` (`distinctUntilChanged`) emits nothing. `recoveryStateChangedHint$` fires, but also for tomux's own clearing and for custom-title visibility, so a user clearing the name cannot be told apart. Hooking `setCustomTitle` on the tab instance would work but adds another Tabby-internals patch.

Decision (asked, no preference, recommendation taken): no empty-rename handling. Because a `tmux:<digits>` name counts as unnamed (decision 2), renaming the tab in Tabby, or the window in tmux, to `tmux:<n>` already makes the tab follow the program's title again. `watchTabbyRename` keeps ignoring empty custom titles. README documents the reset.

Also from the source: the rename dialog is pre-filled with the title the tab shows, so opening "Rename tab" on a program title and pressing Enter pins that title as the window name, as the spec's "Rename in Tabby to the shown program title" scenario requires.

## Risks / Trade-offs

- [The assumption that `%output` carries OSC 0/2 is wrong for some tmux versions or settings] → Task 1 tests it on the test host before anything else. Fallback: a tmux subscription on `#{pane_title}` (decision 1 alternative).
- [Shells that set a title at every prompt change what existing users see] → Documented in `README.md`. The profile toggle turns it off.
- [`#{pane_title}` defaults to the host name, but an app could set the host name as its title] → The tab then shows `tmux:<n>` after a reconnect until the program sets a title again. Acceptable.
- [Newer tmux has an option that stops programs setting the pane title] → Live titles still arrive through `%output`. Only the seed after reattach is lost. Acceptable.
- [Splits: one program title per pane, joined by Tabby's split container] → No change needed; each tomux pane tab computes its own title.
- [Known limitation: toggling "Disable dynamic tab title" does not refresh open tabs at once] → The next title event applies it. Pane switches made while the toggle is on skip the tmux read, so turning it off can show an earlier pane's title until the program sets one or the tab reattaches. Accepted; watching config changes is not worth it for a rarely changed setting.
- [Known limitation: a host renamed after its panes were created] → tmux stamps a new pane's title with the host name at creation, and tomux compares with the current `#{host}`. Untitled panes from before a hostname change (for example a DHCP or Bonjour rename) show the old hostname after a reattach, instead of `tmux:<n>`. Accepted; guessing which titles look like host names would hide real titles.

## Migration Plan

No data migration. Rolling back restores the old behaviour; window names in tmux are not touched by program titles, so nothing in tmux needs to be cleaned up.
