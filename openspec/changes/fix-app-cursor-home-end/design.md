# Design

## Context

See proposal.md for the bug and the reproduction.

`encodeSendKeys` in `src/tmux/sendKeys.ts` turns xterm.js input into tmux `send-keys` commands. A sequence found in `KEY_MAP` goes out as a key name (`send-keys -t %3 Home`), and tmux then encodes that key for the pane's own terminal type and modes. Any other escape sequence goes out as one hex command so it reaches the pane in a single write. `findEscSequenceLength` treats `ESC O <byte>` as such an unknown SS3 sequence unless `KEY_MAP` lists it; `ESC O P`–`ESC O S` (F1–F4) are already listed.

Nothing in `src` strips or tracks cursor-key mode (no match for DECCKM or `?1h` outside tests), so the program's mode switch reaches xterm.js and xterm.js changes what it sends for Home, End and the arrows.

Read in the code: the map, the SS3 handling and the existing test at `sendKeys.spec.ts` ("hex-encodes unknown sequences atomically (SS3 arrows, modified arrows)") that asserts `ESC O A` becomes `0x1b 0x4f 0x41`. Reported by the user, not re-run for this proposal: the vim reproduction and the fact that key names fix it.

## Goals / Non-Goals

**Goals:**
- Home, End and the arrows behave the same in application cursor mode as in normal mode.
- Keep the fix inside the existing key map, with no new state.

**Non-Goals:**
- Application keypad mode (numeric keypad sequences such as `ESC O M`, `ESC O j`–`ESC O y`).
- Modified keys (`ESC [ 1 ; <mod> H` and similar); they stay hex-encoded as today.
- Changing what the output side passes to xterm.js.

## Decisions

### 1. Add the application-mode sequences to `KEY_MAP`

Add `ESC O H` → `Home`, `ESC O F` → `End`, `ESC O A` → `Up`, `ESC O B` → `Down`, `ESC O C` → `Right`, `ESC O D` → `Left`. The existing lookup then sends them by name, and `findEscSequenceLength` stops claiming them because it already defers to any multi-byte `KEY_MAP` entry. No other code changes.

Alternatives considered:
- **Strip the mode switch (`CSI ? 1 h` / `CSI ? 1 l`) from pane output** so xterm.js never leaves normal mode. This puts more parsing on the output path for every pane, and a sequence split across two `%output` chunks would need buffering. The input-side map is six lines and has no state.
- **Map only Home and End.** That is the smallest fix for the reported bug, but the arrows would keep depending on the pane's terminfo listing `ESC O A`–`D`. Sending them by name is the same mechanism and removes the dependency.

### 2. The arrows change from hex to key names

This reverses an asserted behaviour, so the existing test is rewritten rather than deleted: it keeps asserting that a modified arrow (`ESC [ 1 ; 5 C`) is hex-encoded atomically, and uses an SS3 sequence that stays unknown (for example `ESC O M`) for the SS3 half. The atomic-write concern behind the hex path (tmux-integrated issue #26) does not apply to a key name: it is one `send-keys` argument and tmux writes the key's encoding in one piece.

### 3. Test-side reverse map

`KEY_NAMES` in `sendKeys.spec.ts` maps each key name to one sequence for `decodeAll` round trips. Two sequences now share a name, so the round-trip helper keeps the normal-mode form, and the new tests assert the emitted commands directly instead of round-tripping.

## Risks / Trade-offs

- [A program reads `ESC O A`–`D` literally and its terminfo disagrees with what tmux emits for `Up`] → tmux picks the encoding from the pane's own cursor mode, which is the point of sending key names; this is the same path the normal-mode arrows already use.
- [Pasted or program-generated text containing `ESC O H`] → it is now sent as `Home` instead of raw bytes. The same already holds for `ESC [ H` and every other mapped sequence, so this adds no new class of behaviour.
- [The check in a running Tabby cannot be done in the implementing session] → state that plainly in the final report, as the project's "Done means" requires; unit tests still cover the encoding.
