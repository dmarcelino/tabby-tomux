# Spec Delta

## MODIFIED Requirements

### Requirement: Output and scrollback
A tomux tab SHALL show the bound pane's output as it is produced. When a tab binds to a tmux window that already existed, it SHALL first show that pane's existing scrollback and screen and place the cursor where tmux has it. While the pane's program is in the alternate screen, the scrollback and the screen behind the program SHALL be on the tab's normal screen, behind the program's screen.

#### Scenario: Adopting an existing window
- **WHEN** a tomux tab binds to an existing window with 2,000 lines of history
- **THEN** the tab shows that history and the current screen before any new output

## ADDED Requirements

### Requirement: Redrawn tab keeps the program's alternate screen
When a tomux tab draws a pane from tmux (adopting its window, reconnecting, or following a new active pane) and the pane's program is in the alternate screen, the tab SHALL show the program's screen on its own alternate screen. The shell's history and screen SHALL be on the tab's normal screen behind it, with the cursor where the program leaves it on exit. When the program leaves the alternate screen, the tab SHALL show the shell's screen and nothing of the program's.

#### Scenario: Exiting Claude Code after Tabby restarts
- **GIVEN** a tomux tab whose window runs Claude Code, started from a shell prompt
- **WHEN** Tabby restarts, the tab is restored, and the user then exits Claude Code
- **THEN** the tab shows the shell's history and screen as they were before Claude Code started, followed by what the shell prints after it exits, with no part of Claude Code's screen left on it

#### Scenario: Restored tab while the program runs
- **WHEN** Tabby restarts with a tomux tab open on a window running a full-screen program, and the tab is restored
- **THEN** the tab shows the program's screen with the cursor where tmux has it, and scrolling up does not show the shell's history while the program runs

#### Scenario: Program exits while the tab is disconnected
- **GIVEN** a tomux tab showing a full-screen program
- **WHEN** the connection drops, the program exits before the tab reconnects, and the tab then reconnects
- **THEN** the tab shows the shell's history and screen, and the shell's later output, on its normal screen

#### Scenario: Active pane changes from a full-screen program to a shell
- **GIVEN** a tomux tab showing a pane that runs a full-screen program
- **WHEN** the window's active pane changes to a pane running a shell
- **THEN** the tab shows the shell pane's history and screen on its normal screen, and scrolling up shows that pane's history

#### Scenario: Active pane changes twice in quick succession
- **WHEN** the window's active pane changes from a shell pane to a pane running a full-screen program and, before the tab has redrawn it, to another shell pane
- **THEN** the tab ends up showing the last pane only, and that pane's later output is not lost

#### Scenario: Pane not in the alternate screen
- **WHEN** a tomux tab adopts a window whose pane is not in the alternate screen
- **THEN** the tab shows the pane's history and screen on its normal screen, as before this change

### Requirement: Redrawn tab takes the pane's cursor visibility and mouse mode
When a tomux tab draws a pane from tmux, the tab's cursor SHALL be shown or hidden as tmux reports it for the pane, and the tab's mouse reporting SHALL be the mode tmux reports for the pane, or off when tmux reports none. Settings a program left on in the tab SHALL NOT carry over to a pane that doesn't have them.

#### Scenario: Restored tab of a program that hides the cursor
- **WHEN** Tabby restarts with a tomux tab on a window running a full-screen program that hides the terminal cursor, and the tab is restored
- **THEN** the tab doesn't show a terminal cursor over Claude Code's screen

#### Scenario: Program with mouse reporting exits while the tab is disconnected
- **GIVEN** a tomux tab showing vim with mouse reporting on
- **WHEN** vim exits while the tab is disconnected, and the tab then reconnects
- **THEN** the shell prompt shows the cursor, and scrolling the mouse wheel scrolls the tab instead of typing escape codes at the prompt

#### Scenario: Restored tab of a program with mouse reporting
- **WHEN** Tabby restarts with a tomux tab on a window running a program with mouse reporting on, and the tab is restored
- **THEN** the program receives mouse clicks in the tab
