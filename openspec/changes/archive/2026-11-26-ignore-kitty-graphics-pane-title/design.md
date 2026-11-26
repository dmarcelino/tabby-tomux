# Design

## Context

See proposal.md, "Why", for the bug.

tomux shows two kinds of program title:
- **Live titles.** xterm.js parses OSC 0/2 in the tab's output and `TabTitleController.onProgramTitle` takes them. xterm.js does not treat APC as a title, so a graphics query never reaches this path.
- **Stored titles.** On `attach` (new tab, restore, reconnect) and `onPaneChanged`, the controller calls the host's `readProgramTitle`. In `src/components/tomuxTab.component.ts` that runs `ControlClient.getPaneTitle` (`display-message -p -t <pane> "#{host}|#{pane_title}"`) and passes the result to `programTitleFromPane(paneTitle, host)` in `src/tabTitle.ts`. Today that function returns null for an empty title or the host name, and the title otherwise.

tmux sets `#{pane_title}` from OSC 0/2 and also from any APC sequence (`ESC _ … ESC \`), a `screen` compatibility feature. Both are governed by the `allow-set-title` option. tmux has no way to keep OSC titles and drop APC ones.

Kitty graphics commands have the form `ESC _ G <keys> [; <payload>] ESC \`. The keys are comma-separated `<letter>=<value>` pairs, and each value is a number (possibly negative) or a single character. tmux stores everything between `ESC _` and `ESC \`, so `#{pane_title}` becomes `G<keys>[;<payload>]`.

## Goals / Non-Goals

**Goals:**
- A stored pane title that is a Kitty graphics command never becomes the tab title.
- One change point that covers attach, restore, reconnect and pane switches.

**Non-Goals:**
- Recovering the real title the query overwrote. tmux keeps no history of titles, and tomux does not save program titles in the recovery token. Saving them would be a separate change.
- Other APC payloads. Only Kitty graphics commands were seen, and other APC uses have no common shape to match.
- Changing tmux options on the user's server.

## Decisions

### 1. Filter in `programTitleFromPane`

`programTitleFromPane` already turns tmux's "no real title" values (empty, host name) into null. A graphics command is one more such value, so it goes in the same place. The single caller and both controller paths (`attach`, `onPaneChanged`) are covered without changes. `pickDisplayTitle` then falls back to the window name or `tmux:<n>`, as for an untitled pane.

Alternatives considered:
- **Filter in `TabTitleController` or `pickDisplayTitle`.** These also see live OSC titles, which never carry APC. Filtering there would apply the heuristic where it isn't needed and could hide a live title for no reason.
- **Filter in `ControlClient.getPaneTitle`.** That file is ported from tmux-integrated and reports tmux's values as they are. Deciding what counts as a title is tomux's title logic, which lives in `src/tabTitle.ts`.
- **Set `allow-set-title off`.** Blocks OSC titles too, which tomux depends on.

### 2. Match the shape of the command, not the probe

The test is the regular expression `^G[a-zA-Z]=[^,;\s]*(?:,[a-zA-Z]=[^,;\s]*)*(?:;|$)`, applied to the trimmed title. It matches every Kitty graphics command, not just the support query, because transmit, place and delete commands (`Ga=T,f=100;…`, `Ga=d,d=A`, chunks `Gm=0;…`) reach tmux the same way.

Values exclude whitespace. This is tighter than the pattern first suggested during diagnosis (`[^,;]*`): Kitty values never contain spaces, and the tighter pattern no longer matches titles like `Gx=1 build`. Checked with node: it matches `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA`, `Ga=d,d=A`, `Gm=0;abc`, `Gf=100,a=T,m=1,z=-1;iVBOR` and `Ga=q,i=1`. It does not match `Go away`, `GPU=1`, `Gx=1 build`, `Gx=1, y=2` or `fix login bug`.

Alternative considered: match only the exact probe string. Simpler, but other programs send different queries (other ids, `f=32`, a different payload), so it would fix only this one case.

### 3. Tests

Unit tests in `src/tabTitle.spec.ts`, `describe('programTitleFromPane')`: the exact string from the bug returns null, the other graphics commands above return null, and the non-matching titles above are returned unchanged. A `TabTitleController` test checks that an attach whose `readProgramTitle` reads the query shows `tmux:<n>`. Since the filter lives in `programTitleFromPane`, that test goes through a host whose `readProgramTitle` calls `programTitleFromPane`, as the tab component does.

## Risks / Trade-offs

- [A real title that looks like `Gx=…` with no spaces] → It is hidden on reattach and the tab shows the window name. The live title is still shown, because the filter only applies to stored titles. Very unlikely, and the program's next title fixes it.
- [The tab shows `tmux:<n>` after restore instead of the program's real title] → The real title is gone from tmux. This is the same as for a pane that never set a title, and better than the query. Claude Code sets a new title when its state changes.

## Migration Plan

None. Rolling back means reverting the change to `programTitleFromPane`.
