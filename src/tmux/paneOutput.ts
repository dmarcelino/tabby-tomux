// SPDX-License-Identifier: GPL-3.0-only
// Ported from tmux-integrated src/tmuxTerminalProvider.ts (normalizeTerminalOutput)
// at commit 0f92f4a. Copyright (C) the tmux-integrated authors.
// Changes: extracted from the VS Code Pseudoterminal into a small class;
// bare-LF → CRLF rewrite removed (see 'tomux:' note).

/**
 * Normalises decoded tmux pane output before it reaches the terminal (xterm.js):
 *   1. Strips screen/tmux title sequences (\ek…\e\\) that xterm.js doesn't
 *      understand. oh-my-zsh's termsupport.zsh emits these in preexec and
 *      precmd when TERM matches screen* or tmux*. xterm.js treats \ek as an
 *      unknown two-char escape and prints the enclosed text as visible
 *      characters, producing a "command echo" effect.
 *   2. Strips terminal-status queries (DSR `\x1b[…n`, DA `\x1b[…c`) that tmux
 *      itself already answers from the pane's virtual screen state (tmux's
 *      input.c INPUT_CSI_DSR / INPUT_CSI_DA handlers). Without this, xterm.js
 *      sees the query, emits its OWN reply, and that reply rides back through
 *      send-keys into the program's stdin a moment after tmux's own reply,
 *      leaking fragments like `;145R;56R` into the next prompt
 *      (tmux-integrated issue #26).
 *   3. Strips OSC 10/11 colour query responses that would otherwise render as
 *      visible garbage (for example when `bat` queries fg/bg colours).
 *
 * tomux: the original also turned every bare LF into CRLF, tracking a CR that
 * ended the previous chunk. That was a workaround for VS Code's
 * Pseudoterminal and is wrong for a real terminal: tmux passes the pane's pty
 * bytes through verbatim, so cooked-mode output already arrives as CRLF, and
 * a bare LF comes from a raw-mode program (vim, less, a TUI) that means
 * "cursor down, same column". Rewriting it moved the cursor to column 0 and
 * corrupted such screens. Line endings now pass through unchanged. (The
 * adoption snapshot from capture-pane is joined with '\n' and converted to
 * CRLF where it is written, not here.)
 *
 * Known limitation, inherited: a sequence split across two %output chunks is
 * not stripped.
 */
export class PaneOutputNormalizer {
    normalize (data: string): string {
        // Strip \ek<text>\e\\ (screen/tmux hardstatus title sequence).
        data = data.replace(/\x1bk[^\x1b]*\x1b\\/g, '')

        // Strip DSR / DA queries that tmux already answers internally.
        //   CSI <private?> <params> n   → DSR (status / cursor position)
        //   CSI <private?> <params> c   → DA  (device attributes)
        data = data.replace(/\x1b\[[?>=<]?[\d;]*[nc]/g, '')

        // Strip OSC 10/11 colour query responses (ST is BEL or ESC \).
        data = data.replace(/\x1b\]1[01];[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

        return data
    }

    /**
     * tomux: kept for callers that reset the normalizer when a pane restarts.
     * There is no state left to clear since the LF rewrite was removed.
     */
    reset (): void {
        // Nothing to reset.
    }
}
