# Spec Delta

## MODIFIED Requirements

### Requirement: Tabby tab hotkeys keep working
tomux tabs SHALL behave as ordinary Tabby top-level tabs for Tabby's tab navigation and arrangement hotkeys, such as next tab, previous tab, go to tab N, and move tab left or right.

#### Scenario: Switch tabs by number
- **WHEN** three tomux tabs are open and the user presses Tabby's "go to tab 2" hotkey
- **THEN** the second tab becomes active and receives keyboard input

#### Scenario: Reorder tabs
- **WHEN** the user moves a tomux tab left
- **THEN** the tab moves in Tabby's tab bar and the tmux window numbers are unchanged (the new order is recorded only in `@tomux-order`, see `tmux-tab-recovery`)
