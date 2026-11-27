## ADDED Requirements

### Requirement: A shorter pane scrolls within its rows
When the pane a tomux tab shows is shorter than the tab, the tab SHALL show the pane on its top rows and scroll only those rows, as tmux scrolls the pane. A line that scrolls off the pane's top row SHALL go to the tab's scrollback. The tab's rows below the pane SHALL stay empty. A pane as tall as the tab SHALL behave as before.

#### Scenario: New line on the pane's last row
- **GIVEN** a tab shows an 11-row pane of a window with two panes, in a 25-row tab, and the shell's prompt is on the pane's last row
- **WHEN** the user runs `echo one` and then `echo two`
- **THEN** the tab's top 11 rows are the same as tmux's capture of the pane, the cursor is where tmux has it, and the tab's rows 12 to 25 are empty
- **AND** the lines that scrolled off the pane's top row are in the tab's scrollback, in order

#### Scenario: Pane border status line
- **GIVEN** tmux draws a status line in the pane borders (`pane-border-status top` or `bottom`), and a tab shows a pane of a window with two panes
- **WHEN** a command prints more lines than the pane has rows
- **THEN** the tab scrolls within the pane's rows, without the status line's row, matching tmux's capture of the pane

#### Scenario: Window with one pane
- **WHEN** a tab shows a window with one pane and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row and keeps every line in its scrollback, as before this change

### Requirement: A shorter pane keeps its rows when programs and resizes reset them
A tab showing a pane shorter than itself SHALL keep scrolling within the pane's rows after anything that would otherwise give the scrolling back to the whole tab: a program setting or resetting its own scroll region, a program entering or leaving the alternate screen, a terminal reset, and a resize of the tab. A program's own scroll region inside the pane SHALL still apply as the program set it.

#### Scenario: Program resets its scroll region
- **GIVEN** a tab shows an 11-row pane in a 25-row tab
- **WHEN** a program in the pane sets a scroll region of rows 2 to 5, scrolls in it, then resets the scroll region and prints lines until the pane scrolls
- **THEN** the region of rows 2 to 5 scrolls as the program set it, and after the reset the tab scrolls within the pane's 11 rows, matching tmux's capture of the pane

#### Scenario: Full-screen program in a short pane
- **GIVEN** a tab shows an 11-row pane in a 25-row tab
- **WHEN** a program enters the alternate screen, prints more lines than the pane has rows, and exits
- **THEN** while it runs and after it exits, the tab's top 11 rows and its cursor are the same as tmux's, and the rows below the pane are empty

#### Scenario: Tab resized
- **GIVEN** a tab shows a pane shorter than the tab
- **WHEN** the user resizes the Tabby window and then a command prints more lines than the pane has rows
- **THEN** the tab scrolls within the pane's rows at the pane's new height, matching tmux's capture of the pane

### Requirement: A shorter pane's rows follow its height
The rows a tab scrolls SHALL follow the shown pane's height in tmux: when the window's layout changes (a pane is added, closed, resized or zoomed) and when the window's active pane changes to a pane of another height. When the height of a pane shorter than its window changes, the tab SHALL show the pane's lines and cursor as tmux has them after the change, before the pane's next output.

#### Scenario: Other pane closed
- **GIVEN** a tab shows an 11-row pane of a window with two panes, in a 25-row tab
- **WHEN** the other pane is closed in tmux, so the shown pane becomes 25 rows tall, and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row, matching tmux's capture of the pane

#### Scenario: Pane zoomed
- **GIVEN** a tab shows an 11-row pane of a window with two panes
- **WHEN** the pane is zoomed in tmux and a command prints more lines than the tab has rows
- **THEN** the tab scrolls at its last row; when the pane is unzoomed, the tab's top rows and cursor are the same as tmux's capture of the pane, and new output scrolls within the pane's rows again

#### Scenario: Tab made shorter
- **GIVEN** a tab shows an 11-row pane of a window with two panes, with the cursor on the pane's last row
- **WHEN** the user makes the Tabby window shorter, so the pane becomes 8 rows tall
- **THEN** the tab's top 8 rows and its cursor are the same as tmux's capture of the pane, the rows below are empty, and new output scrolls within the 8 rows

#### Scenario: Active pane changes to a pane of another height
- **GIVEN** a window has a 7-row pane and a 17-row pane, and the tab shows the 7-row pane
- **WHEN** the 17-row pane becomes active and a command in it prints more lines than it has rows
- **THEN** the tab shows the 17-row pane on its top 17 rows and scrolls within them, matching tmux's capture of the pane
