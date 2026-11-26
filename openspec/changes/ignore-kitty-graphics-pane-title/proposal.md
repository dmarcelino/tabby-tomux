# Proposal

## Why

A restored tomux tab can start with a title like `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA` instead of the program's real title. This was seen on a tab running Claude Code. The string is the body of a Kitty graphics query (`ESC _ G … ESC \`): a 1×1 pixel sent with `a=q` to ask the terminal whether it supports images. tmux treats every APC sequence (`ESC _ … ESC \`) as a title, for compatibility with `screen`, so the query replaces the pane's `#{pane_title}`. While the tab is live, xterm.js ignores APC and the tab keeps the real title. When the tab attaches again (restore, reconnect, pane switch), tomux reads `#{pane_title}` and shows the query. It stays until the program sets a new title. On the affected machine, two Claude Code panes had this exact `#{pane_title}`. A throwaway tmux 3.8 server reproduced it: a title set with OSC 2 was replaced by the query body. Which program sent the query (Claude Code or a tool it ran) was not confirmed.

## What Changes

- When tomux reads a pane's title from tmux, a title that has the shape of a Kitty graphics command is treated as no title, like tmux's default host-name title. The tab then shows the window's name, or its placeholder `tmux:<n>`, until the program sets a title again.
- The shape is: `G`, then one or more comma-separated `<letter>=<value>` keys, then `;` (and any payload) or the end of the string.
- Titles that programs set while the tab is live are not affected: they come from xterm.js, which never sees APC.
- tmux's `allow-set-title` is left alone. Turning it off would also block the OSC 0/2 titles that tomux shows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-window-tabs`: "Program title survives reattach and pane switches" gains a second exception. A title tmux holds that is a Kitty graphics command is not taken as the program's title. A new scenario covers a restored tab.

## Impact

- Code: `programTitleFromPane` in `src/tabTitle.ts`, plus unit tests in `src/tabTitle.spec.ts`. Its one caller, `readProgramTitle` in `src/components/tomuxTab.component.ts`, is unchanged.
- No API, dependency or configuration changes.
- What users see: a restored, reconnected or pane-switched tab no longer shows a graphics query as its title. The real title it had before the query is lost, because tmux overwrote it, so the tab shows the window's name until the program sets a title again.
- Trade-off: a real title that happens to look like `Gx=…` is hidden. This is very unlikely.
- `doc/TESTING.md` gets the result of the check in a running Tabby.
