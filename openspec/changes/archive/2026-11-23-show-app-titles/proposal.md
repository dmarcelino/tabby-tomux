# Proposal

## Why

On a local terminal, programs set the tab title with OSC 0/2 escape sequences. Claude Code, for example, names the tab after the task it is working on. In a tomux tab these titles never show: the tab follows only the tmux window name, and tomux sets `disableDynamicTitle = true`, so Tabby drops the title even though the sequence reaches the tab's terminal through `%output`. Users who run such programs over tomux lose a cue they rely on locally.

## What Changes

- A tomux tab shows the title the program in its pane sets (OSC 0/2), as a local Tabby tab does, **while the tmux window has no name of its own** (still `tmux:<n>`).
- A window name the user chose (Tabby's "Rename tab" or tmux `rename-window`) keeps priority over the program's title, like Tabby's custom title does on a local tab.
- The program's title is shown in Tabby only. tomux never renames the tmux window because of it, so tmux names stay the user's and frequent title updates cost no tmux commands.
- Renaming a tab or window to `tmux:<n>` makes the tab follow the program's title again, because that name counts as no name of its own. (An empty rename was considered, but Tabby gives no signal when a tab is renamed to an empty name.)
- After a reconnect, a restore, or a pane switch inside tmux, the tab takes the title from tmux's `#{pane_title}`, because the replayed history holds no title sequences.
- Tabby's per-profile "Disable dynamic tab title" toggle, set on the tomux profile, turns this off. It follows Tabby's default (titles on). **Visible change:** unnamed tabs show whatever title the remote shell sets, for example `user@host: ~/src`, instead of `tmux:<n>`.

Out of scope: writing program titles into tmux window names, tmux `automatic-rename` based on `#{pane_title}`, screen-style `\ek…\e\\` titles (still stripped), and a tomux-specific setting.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `tmux-window-tabs`: the requirement "Tab title follows the tmux window name" changes. The tab shows the program's title while the window is unnamed, the user's name otherwise, and honours the profile's dynamic-title toggle.

`tmux-window-tabs` is defined by the in-progress change `add-tomux-plugin` and is not yet under `openspec/specs/`. This change's delta modifies that requirement, so `add-tomux-plugin` must be archived before this one.

## Impact

- **Code**: `src/components/tomuxTab.component.ts` (title flow, Tabby-rename handling, pane switch), the title policy in `src/tmux/windowTitle.ts` / `src/titleEcho.ts`, and `src/tmux/controlClient.ts` (read `#{pane_title}` and the host name). No new Tabby internals; `frontend.title$` and `disableDynamicTitle` are public `tabby-terminal` / `tabby-core` APIs.
- **Tabby**: none. tomux keeps blocking Tabby's own dynamic-title handler and applies its own precedence instead.
- **Remote hosts**: no new tmux requirements expected; the spike confirms that `%output` carries OSC 0/2 and what `#{pane_title}` holds by default.
- **Docs**: `README.md` (Titles), `doc/TESTING.md` (manual test with Claude Code and a shell that sets titles).
