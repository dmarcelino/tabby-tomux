# Proposal

## Why

The [tabby-trzsz](https://github.com/trzsz/tabby-trzsz) plugin (`tsz` / `trz` file transfer over the terminal) works in Tabby's SSH tabs and in tabby-tmux tabs, but not in tomux tabs. Two tomux behaviours cause this:

1. **A typed line feed reaches the pane as a carriage return.** `encodeSendKeys` sends a bare `\n` as the tmux key `Enter`, which tmux writes as `\r`. trzsz ends every message with `\n` and the remote `tsz` reads in raw mode until it sees one, so the first reply (`#ACT:…`) never completes and the transfer times out. This also breaks the existing requirement "Input reaches the pane unchanged". The user confirmed on their remote that Ctrl-J in a raw-mode tomux pane arrives as `0d`. A local end-to-end check with tomux's compiled encoder and a stand-in `tsz` that reads until `\n` timed out with the current code and completed once `\n` went out as `C-j`.
2. **Replayed history goes through Tabby's session middleware as if it were new output.** tabby-trzsz is a session middleware and watches output for its start line (`::TRZSZ:TRANSFER:…`). tmux keeps that line in the pane's history after a transfer. tomux shows history again when it adopts a window, redraws a reconnecting tab or follows a new active pane, and it sends that replay through `emitOutput`, so trzsz sees it. Under tmux control mode, trzsz gives the transfer an id that trzsz.js never treats as a repeat, so every replay can start a transfer that does not exist: a folder dialog, or `#ACT:…` typed into the shell followed by a timeout. This was found by reading tomux, Tabby, trzsz-go and trzsz.js and has not been reproduced. tabby-tmux avoids it by sending its history replays past the middleware.

## What Changes

- A bare `\n` in terminal input reaches the pane as a line feed (`send-keys … C-j`), not as Enter. `\r` still goes out as Enter. Typing and Tabby's paste on macOS and Linux are unaffected, because both send `\r`.
- **Behaviour change (small):** Ctrl-J, and a bare LF in text pasted on Windows (Tabby only converts CRLF there), now reach the program as a line feed, as they do in a Tabby SSH tab. Shells treat a line feed like Enter. A program that binds Ctrl-J differently (for example `fzf`, where it moves down) now sees Ctrl-J, as in a Tabby SSH tab.
- History and screen that tomux replays (adopting a window, redrawing on reconnect, following a new active pane) are shown in the tab without passing through Tabby's session middleware. Live pane output still passes through it, so tabby-trzsz and Tabby's own output processing still see everything the pane produces from then on.
- README: a short note that tabby-trzsz works in tomux tabs, that transfers use base64 under tmux (trzsz turns off binary mode itself), and that uploads go through `send-keys`.
- No new profile options, no new dependencies, no change to how other keys are encoded.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-window-tabs`: "Input reaches the pane unchanged" gains a line-feed scenario. A new requirement states that replayed history does not go through Tabby's session middleware, where plugins such as tabby-trzsz watch output, and a new requirement states that tabby-trzsz file transfers work in a tomux tab.

## Impact

- `src/tmux/sendKeys.ts`: the bare `\n` → Enter branch goes away (a file ported from tmux-integrated; its header's "Changes:" line gets one more item). `src/tmux/sendKeys.spec.ts`: changed expectation and the reverse-map comment.
- `src/outputGate.ts`: the replay and live output are passed to the session separately.
- `src/paneSession.ts`: replays are shown without going through the middleware; live output still uses `emitOutput`. `src/paneSession.spec.ts`: the mocked `BaseSession` needs to tell the two paths apart.
- `src/tabbyAdapter.ts`: a small function that shows text past the session middleware (it uses `BaseSession`'s protected output subjects), with a test.
- `README.md`, `doc/TESTING.md`.
- Upload speed with `trz` is unmeasured. Base64 goes out mostly as literal `send-keys -lt` runs, about 1,400 commands (about 200 written lines) per MB.
