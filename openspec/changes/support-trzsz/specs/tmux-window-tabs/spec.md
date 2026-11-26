# Spec Delta

## MODIFIED Requirements

### Requirement: Input reaches the pane unchanged
Everything the user types or pastes in a tomux tab SHALL reach the bound tmux pane in order and unchanged, including spaces, non-ASCII text, control keys and escape sequences.

#### Scenario: Fast typing with spaces
- **WHEN** the user quickly types `echo a b  c` and Enter
- **THEN** the shell runs `echo a b  c` with both spaces preserved

#### Scenario: Large paste
- **WHEN** the user pastes 100 KB of text into a tomux tab
- **THEN** the pane receives the complete text in order

#### Scenario: Escape sequences
- **WHEN** the user presses arrow keys in a full-screen program such as `vim`
- **THEN** the program receives each key as one intact sequence

#### Scenario: Line feed stays a line feed
- **GIVEN** a program in the pane that has put the terminal in raw mode and prints each byte it reads
- **WHEN** the terminal sends a line feed (`\n`) to the tab, as Ctrl-J or as a terminal plugin's input
- **THEN** the program reads the byte `0a`, not `0d`

#### Scenario: Enter is still a carriage return
- **GIVEN** the same raw-mode program
- **WHEN** the user presses Enter
- **THEN** the program reads the byte `0d`

## ADDED Requirements

### Requirement: Replayed history is not new output
History and screen content that a tomux tab draws again from tmux, when it adopts a window, redraws on reconnect or follows a new active pane, SHALL be shown in the tab without passing through Tabby's session middleware, where plugins such as tabby-trzsz watch the output. Output the pane produces after that SHALL pass through the session middleware as usual.

#### Scenario: Old transfer line in history
- **GIVEN** a tmux window whose history contains the start line of a finished tabby-trzsz transfer, and Tabby with tabby-trzsz installed
- **WHEN** a tomux tab adopts that window, is reconnected, or follows the window to another pane whose history has such a line
- **THEN** the history is shown, no file dialog opens, no transfer starts and nothing is typed into the pane

#### Scenario: Live output after a replay
- **WHEN** a tomux tab has adopted a window and the user then runs `tsz` in it
- **THEN** tabby-trzsz sees the new start line and the transfer begins

### Requirement: File transfer with tabby-trzsz
With tabby-trzsz installed in Tabby and `trzsz` installed on the host, `tsz` and `trz` run in a tomux tab SHALL transfer files as they do in a Tabby SSH tab to the same host.

#### Scenario: Download with tsz
- **WHEN** the user runs `tsz <file>` in a tomux tab
- **THEN** the file is saved on the user's machine with the same content as on the host

#### Scenario: Upload with trz
- **WHEN** the user runs `trz` in a tomux tab and picks a file
- **THEN** the file is written on the host with the same content as on the user's machine

#### Scenario: Tab keeps working after a transfer
- **WHEN** a transfer in a tomux tab has finished
- **THEN** the shell prompt returns, and typing and output in the tab work as before
