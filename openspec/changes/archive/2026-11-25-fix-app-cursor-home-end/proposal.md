# Proposal

## Why

In a tomux tab, Home and End break in programs that turn on application cursor mode, such as `vim`: pressing Home in insert mode leaves insert mode, opens a line above and types `H`; End does the same with `F`. Once the program has switched the mode on, xterm.js sends Home and End as `ESC O H` and `ESC O F`. tomux only knows the normal-mode forms (`ESC [ H`, `ESC [ F`), so it passes the application-mode bytes to the pane as raw hex and tmux never gets to translate them for the program.

The user reproduced this against a throwaway tmux server: typing `abc`, Home, `X`, End, `Y` in vim gave three lines (`FY` / `HX` / `abc`) when the keys were sent the way tomux sends them, and `XabcY` when they were sent as the key names `Home` and `End`. The same sequences through a normal tmux client behaved correctly with and without the user's tmux config, so tmux settings are not involved.

## What Changes

- Home and End pressed while the pane's program has application cursor mode on are sent to tmux as the keys `Home` and `End`, the same as in normal mode.
- The four arrow keys in application cursor mode (`ESC O A`–`ESC O D`) are also sent as the keys `Up`, `Down`, `Right`, `Left`. They work today only because `tmux-256color` happens to list those byte sequences for the arrows; sending them by name removes that dependency.
- The existing unit test that expects `ESC O A` to be hex-encoded changes to expect the key name.
- No change for other SS3 sequences, modified keys (`ESC [ 1 ; 5 C` and the like), terminal replies or pasted text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-window-tabs`: adds a requirement that cursor, Home and End keys work in programs that use application cursor mode.

## Impact

- `src/tmux/sendKeys.ts`: six new entries in the key map (a file ported from tmux-integrated; its header lists tomux's changes and gets one more).
- `src/tmux/sendKeys.spec.ts`: new tests, one changed expectation, and the test file's reverse key map.
- `doc/TESTING.md`: result of the check in a running Tabby.
- No new dependencies, no profile options, no change to the commands sent for any other input.
