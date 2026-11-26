# Spec Delta

## ADDED Requirements

### Requirement: Adopted screen does not leak text style
After a tomux tab draws a window's captured history and screen, the terminal SHALL be back to the default text style (no underline, bold, dim, italic, reverse or colours) before any newer output from the pane. Styling seen on the captured screen SHALL NOT carry over to text the program writes later.

#### Scenario: Captured screen ends on underlined text
- **GIVEN** a window whose bottom line ends on underlined, coloured text with no unstyled cells after it, such as Claude Code's status line ending in an underlined `PR #42` link
- **WHEN** a tomux tab adopts that window and the program then redraws the screen without changing the underline or colours first
- **THEN** the redrawn text is not underlined and has only the colours the program set

#### Scenario: Restored tab after Tabby restarts
- **WHEN** Tabby restarts with a tomux tab open on a window running Claude Code, and the tab is restored
- **THEN** the tab shows Claude Code with the same styling as a fresh attach, and no extra underline across the screen

#### Scenario: Active pane changes
- **WHEN** the window's active pane changes and the tab redraws the new pane from a capture
- **THEN** the new pane's later output is not styled by the end of that capture

### Requirement: Adopted screen starts from the default text style
When a tomux tab clears its screen to redraw a window or pane from a capture, the clear and the captured text SHALL start from the default text style, whatever style earlier output in the same tab left switched on. The clear SHALL paint with the default background, and unstyled captured cells SHALL be drawn unstyled.

#### Scenario: Earlier output stopped partway through an update
- **GIVEN** a tab whose last output switched underline and a colour on and never switched them off (the pane's output stopped partway through an update)
- **WHEN** the window's active pane changes, or the tab reconnects and redraws its window
- **THEN** the cleared screen has the default background, and the new capture's unstyled text is neither underlined nor coloured
