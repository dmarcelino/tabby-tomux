# Spec Delta

## ADDED Requirements

### Requirement: Cursor keys work in application cursor mode
When the program in the bound pane has switched the terminal to application cursor mode, the Home, End and arrow keys SHALL reach the program as those keys, exactly as they do in normal cursor mode. They SHALL NOT arrive as an Escape key followed by letters.

#### Scenario: Home and End in vim insert mode
- **WHEN** the user opens `vim` in a tomux tab, enters insert mode, types `abc`, presses Home, types `X`, presses End and types `Y`
- **THEN** the buffer holds the single line `XabcY` and vim is still in insert mode

#### Scenario: Arrow keys in vim
- **WHEN** the user presses the arrow keys in `vim` in a tomux tab
- **THEN** the cursor moves one cell per key press and no letters are inserted

#### Scenario: Home and End at a shell prompt
- **WHEN** the user types `abc` at a shell prompt, presses Home, types `X`, presses End and types `Y`
- **THEN** the command line reads `XabcY`
