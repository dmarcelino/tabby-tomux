# Spec Delta

## MODIFIED Requirements

### Requirement: Program title survives reattach and pane switches
When a tomux tab attaches to its window (new tab, restore, reconnect) or the window's active pane changes inside tmux, the tab SHALL take the program's title from the title tmux holds for the active pane, unless that title is tmux's default for a pane no program has titled (the host name), or is a Kitty graphics command that tmux stored as the title (an APC sequence such as a graphics support query). In both cases the tab SHALL show what it shows for a pane with no title.

#### Scenario: Reconnect keeps the title
- **GIVEN** Claude Code set the title `fix login bug` in an unnamed window
- **WHEN** the connection drops and the tab reconnects
- **THEN** the tab title is `fix login bug` without the program setting it again

#### Scenario: Pane never titled
- **GIVEN** no program in the active pane has set a title
- **WHEN** the tab attaches to the unnamed window
- **THEN** the tab title is the window's placeholder name, `tmux:<n>`, not the host name

#### Scenario: Pane switch inside tmux
- **GIVEN** an unnamed window whose two panes have titles `build` and `editor`, and the tab shows `build`
- **WHEN** the active pane changes inside tmux to the `editor` pane
- **THEN** the tab title becomes `editor`

#### Scenario: Graphics query replaced the pane's title
- **GIVEN** a program in an unnamed window set the title `fix login bug`, then wrote the Kitty graphics query `ESC _ Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC \`, so tmux holds `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA` as the pane's title
- **WHEN** Tabby restarts and the tab is restored, or the tab reconnects
- **THEN** the tab title is the window's placeholder name, `tmux:<n>`, not the query, until the program sets a title again

#### Scenario: Graphics query while the tab is live
- **GIVEN** the tab shows the program's title `fix login bug`
- **WHEN** the program writes a Kitty graphics query
- **THEN** the tab title stays `fix login bug`
