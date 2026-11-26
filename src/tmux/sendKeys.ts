// SPDX-License-Identifier: GPL-3.0-only
//
// Ported from tmux-integrated src/tmuxTerminalProvider.ts (KEY_MAP,
// canSendAsLiteral, findEscSequenceLength, sendKeysInput and the reply filter
// in handleInput) at commit 0f92f4a.
// Copyright (C) the tmux-integrated authors
//
// Changes: pure functions returning command strings; 1,024-byte cap; Ctrl-\ and non-ASCII-in-ESC fixes;
// reply filter keeps CSI … R (modified F3); application-cursor-mode arrows, Home and End sent by name;
// bare \n sent as C-j instead of Enter (see 'tomux:' notes).

/**
 * Terminal input → tmux `send-keys` commands.
 *
 * `encodeSendKeys` maps whatever the terminal frontend (xterm.js) produced for
 * a pane — typed or pasted text, escape sequences, control characters — to the
 * ordered list of tmux commands that replay it in the pane. It uses the iTerm2
 * hybrid strategy:
 *
 *   - Unknown ESC sequences (CSI, SS3, OSC, DCS, …) → single hex
 *     `send-keys -t <pane> 0x1b 0x5b …` so the whole sequence is written to
 *     the pane's pty atomically (tmux-integrated issue #26).
 *   - Known escape sequences → `send-keys -t <pane> <KeyName>`
 *   - Safe literal runs     → `send-keys -lt <pane> <chars>`
 *   - Non-ASCII text        → `send-keys -l -t <pane> '<text>'`
 *   - Everything else       → `send-keys -t <pane> 0xNN 0xNN …`
 *
 * tomux: every command is at most MAX_SEND_KEYS_COMMAND_BYTES bytes (UTF-8).
 * tmux-integrated had no cap. Long runs are split into several commands of
 * the same kind, never inside a UTF-8 character (or UTF-16 surrogate pair).
 * Escape sequences are never split as long as they fit in one command, which
 * every key, terminal reply and paste marker does (up to ~200 characters);
 * see `pushHexCommands` for the one exception.
 *
 * The caller sends the commands in order, through the gateway queue, in
 * batches small enough to keep each written line bounded (the gateway joins a
 * `sendCommandList` batch into one line).
 */

import { shellescape } from './controlClient';

/** tomux: upper bound on the UTF-8 length of each returned command (design D8). */
export const MAX_SEND_KEYS_COMMAND_BYTES = 1024;

/** Map of raw terminal escape sequences to tmux key names. */
const KEY_MAP: Record<string, string> = {
    '\r':       'Enter',
    '\x7f':     'BSpace',
    '\x03':     'C-c',
    '\x04':     'C-d',
    '\x1a':     'C-z',
    '\x1b':     'Escape',
    '\t':       'Tab',
    '\x1b[A':   'Up',
    '\x1b[B':   'Down',
    '\x1b[C':   'Right',
    '\x1b[D':   'Left',
    '\x1b[H':   'Home',
    '\x1b[F':   'End',
    // tomux: the same six keys as xterm.js sends them once the program has
    // turned on application cursor mode (DECCKM), as vim does. Sent as raw
    // bytes, ESC O H / ESC O F are not what a program under tmux expects for
    // Home / End: vim read them as Escape, `O`, `H`.
    '\x1bOA':   'Up',
    '\x1bOB':   'Down',
    '\x1bOC':   'Right',
    '\x1bOD':   'Left',
    '\x1bOH':   'Home',
    '\x1bOF':   'End',
    '\x1b[5~':  'PageUp',
    '\x1b[6~':  'PageDown',
    '\x1b[3~':  'DC',
    '\x1b[2~':  'IC',
    '\x1bOP':   'F1',
    '\x1bOQ':   'F2',
    '\x1bOR':   'F3',
    '\x1bOS':   'F4',
    '\x1b[15~': 'F5',
    '\x1b[17~': 'F6',
    '\x1b[18~': 'F7',
    '\x1b[19~': 'F8',
    '\x1b[20~': 'F9',
    '\x1b[21~': 'F10',
    '\x1b[23~': 'F11',
    '\x1b[24~': 'F12',
};

/**
 * Characters that can be sent safely via `send-keys -lt` (literal mode)
 * without tmux's command parser interpreting them.  Matches iTerm2's
 * `canSendAsLiteralCharacter:` in TmuxGateway.m — only alphanumerics
 * and a handful of punctuation known to be safe.
 *
 * Everything else (`;`, `$`, `#`, `"`, `'`, spaces, etc.) is sent as
 * hex code points or, for non-ASCII printable text, via `send-keys -l`
 * to preserve literal UTF-8 input.
 */
function canSendAsLiteral(codePoint: number): boolean {
    if (codePoint >= 0x30 && codePoint <= 0x39) { return true; }   // 0-9
    if (codePoint >= 0x41 && codePoint <= 0x5a) { return true; }   // A-Z
    if (codePoint >= 0x61 && codePoint <= 0x7a) { return true; }   // a-z
    // Same safe punctuation as iTerm2: + / ) : , _
    return codePoint === 0x2b  // +
        || codePoint === 0x2f  // /
        || codePoint === 0x29  // )
        || codePoint === 0x3a  // :
        || codePoint === 0x2c  // ,
        || codePoint === 0x5f; // _
}

const SORTED_KEY_SEQUENCES: string[] =
    Object.keys(KEY_MAP).sort((a, b) => b.length - a.length);

/**
 * If `data[start]` begins an ESC sequence that isn't a known multi-byte
 * KEY_MAP entry, return its length.  Otherwise return 0.
 *
 * Recognises:
 *   - CSI:  ESC [ <params> <final 0x40..0x7E>          (e.g. \x1b[24;80R)
 *   - SS3:  ESC O <one-byte-final>                      (e.g. \x1bOM)
 *   - OSC:  ESC ] <text> ST | BEL                       (e.g. \x1b]0;title\x07)
 *   - DCS / SOS / PM / APC:  ESC <P|X|^|_> <text> ST
 *
 * Used by `encodeSendKeys` to forward such sequences atomically as a single
 * hex-encoded `send-keys`, so an interactive app inside tmux receives the
 * full sequence in one read() instead of several adjacent writes — see
 * tmux-integrated issue #26 (xterm.js's auto CPR reply `\x1b[<r>;<c>R` was
 * being delivered as separate ESC + `[` + params writes and parsed wrongly by
 * `gh`'s prompt library).
 *
 * Returns 0 if `data[start]` is bare ESC followed by nothing or by a
 * recognised KEY_MAP sequence, so the key-name path handles those.
 */
function findEscSequenceLength(data: string, start: number): number {
    if (data[start] !== '\x1b' || start + 1 >= data.length) {
        return 0;
    }
    if (SORTED_KEY_SEQUENCES.some((seq) => seq.length > 1 && data.startsWith(seq, start))) {
        return 0;
    }

    const next = data[start + 1];

    if (next === '[') {
        for (let i = start + 2; i < data.length; i++) {
            const cp = data.charCodeAt(i);
            if (cp >= 0x40 && cp <= 0x7e) {
                return i - start + 1;
            }
        }
        return 0;
    }

    if (next === 'O' && start + 2 < data.length) {
        return 3;
    }

    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        for (let i = start + 2; i < data.length; i++) {
            if (next === ']' && data.charCodeAt(i) === 0x07) {
                return i - start + 1;
            }
            if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') {
                return i - start + 2;
            }
        }
        return 0;
    }

    return 0;
}

/**
 * Drop DSR / DA replies that xterm.js emits on its input channel.
 *
 * Port of the defence-in-depth filter at the top of tmux-integrated's
 * `handleInput`. These can never come from a human keyboard, so dropping them
 * from input is safe:
 *   CSI <private?> <params> n   → DSR response
 *   CSI <private?> <params> c   → DA response
 *
 * tomux: kept separate from `encodeSendKeys` (the original applied it inline
 * before encoding). It only makes sense together with the output-side
 * stripping of DSR/DA queries that tmux already answers itself; without that,
 * the frontend's reply is the only one the program gets.
 *
 * tomux: the original also dropped every `CSI … R` as a cursor-position
 * report (CPR). That deleted real keys: xterm encodes Shift/Ctrl/Alt+F3 as
 * `CSI 1;<mod> R`. A CPR is only sent in reply to a DSR 6 query, and
 * PaneOutputNormalizer strips those before xterm.js sees them, so the
 * frontend never produces a CPR and `R` is left alone.
 */
export function dropTerminalReplies(data: string): string {
    return data.replace(/\x1b\[[?>=<]?[\d;]*[nc]/g, '');
}

/**
 * Map terminal input to the ordered tmux `send-keys` commands for `paneId`.
 *
 * @param data   raw input as the terminal frontend produced it
 * @param paneId tmux pane id such as `%3`
 * @returns      commands in input order, each at most
 *               MAX_SEND_KEYS_COMMAND_BYTES bytes in UTF-8; empty for empty input
 */
export function encodeSendKeys(data: string, paneId: string): string[] {
    // tomux: the pane id is interpolated unquoted, so refuse anything that
    // is not a tmux pane id rather than build a command from it.
    if (!/^%\d+$/.test(paneId)) {
        throw new Error(`encodeSendKeys: invalid tmux pane id ${JSON.stringify(paneId)}`);
    }

    const commands: string[] = [];

    let index = 0;

    while (index < data.length) {
        // 1. Forward unknown ESC sequences (CSI, SS3, OSC, DCS, …) atomically
        //    as a single hex-encoded `send-keys`.  This is critical for
        //    terminal protocol responses such as the cursor-position report
        //    (`\x1b[<row>;<col>R`) that xterm.js auto-replies with: if we
        //    instead split the sequence across multiple `send-keys` commands
        //    (Escape + 0x5b + literals + …), tmux performs separate writes
        //    to the pane's pty and the foreground app's input parser reads
        //    them as separate chunks, often dropping the leading bytes —
        //    leaving fragments like `;<col>R` to land in stdin (issue #26).
        const escLen = findEscSequenceLength(data, index);
        if (escLen > 0) {
            pushHexCommands(commands, paneId, data.slice(index, index + escLen));
            index += escLen;
            continue;
        }

        // 2. Check for known escape sequences (function keys, arrows, etc.)
        const sequence = SORTED_KEY_SEQUENCES.find((candidate) => data.startsWith(candidate, index));
        if (sequence) {
            commands.push(`send-keys -t ${paneId} ${KEY_MAP[sequence]}`);
            index += sequence.length;
            continue;
        }

        const char = data[index];

        // 3. Control characters (< 0x20) → C-x key names.
        //    tomux: this includes a bare \n, which goes out as C-j (tmux
        //    writes 0x0a). The original sent it as Enter, so the pane got
        //    \r: a raw-mode reader waiting for \n (trzsz's tsz/trz) hung.
        //    xterm.js sends \r for Enter and for pasted line breaks, and
        //    that still maps to Enter through KEY_MAP.
        if (char.charCodeAt(0) < 0x20) {
            const letter = String.fromCharCode(char.charCodeAt(0) + 64).toLowerCase();
            // tomux: quote `C-\` (Ctrl-\, 0x1c). Unquoted, tmux's parser reads
            // the trailing backslash as an escape and rejects the whole line
            // ("syntax error"), so the key was lost in the original.
            const key = `C-${letter}`;
            commands.push(`send-keys -t ${paneId} ${letter === '\\' ? shellescape(key) : key}`);
            index += 1;
            continue;
        }

        // 4. Collect a run of printable characters.  Classify each as
        //    "safe literal" or "needs hex".  Build runs of the same kind.
        const cp = char.charCodeAt(0);
        if (canSendAsLiteral(cp)) {
            // Collect consecutive safe-literal characters.
            let litEnd = index + 1;
            while (litEnd < data.length) {
                const nextCp = data.charCodeAt(litEnd);
                if (nextCp < 0x20 || !canSendAsLiteral(nextCp)) { break; }
                if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, litEnd))) { break; }
                litEnd++;
            }
            // tomux: split at the cap. Safe literals are ASCII, one byte each.
            const prefix = `send-keys -lt ${paneId} `;
            const room = MAX_SEND_KEYS_COMMAND_BYTES - prefix.length;
            for (let start = index; start < litEnd; start += room) {
                commands.push(prefix + data.slice(start, Math.min(start + room, litEnd)));
            }
            index = litEnd;
        } else if (cp > 0x7f) {
            // Non-ASCII printable text should be forwarded literally so
            // tmux receives the original UTF-8 input instead of ASCII-only
            // hex key codes.
            let textEnd = index + 1;
            while (textEnd < data.length) {
                const nextCp = data.charCodeAt(textEnd);
                if (nextCp < 0x20 || nextCp <= 0x7f || canSendAsLiteral(nextCp)) { break; }
                if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, textEnd))) { break; }
                textEnd++;
            }
            pushNonAsciiCommands(commands, paneId, data.slice(index, textEnd));
            index = textEnd;
        } else {
            // Collect consecutive hex characters (anything not safe-literal
            // and not a control char or escape sequence).
            let hexEnd = index;
            while (hexEnd < data.length) {
                const nextCp = data.charCodeAt(hexEnd);
                if (nextCp < 0x20 || nextCp > 0x7f) { break; }
                if (canSendAsLiteral(nextCp)) { break; }
                if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, hexEnd))) { break; }
                hexEnd++;
            }
            if (hexEnd > index) {
                pushHexCommands(commands, paneId, data.slice(index, hexEnd));
            }
            index = hexEnd;
        }
    }

    return commands;
}

/**
 * Push `send-keys -t <pane> 0xNN …` for `text`, one token per code point.
 *
 * tomux: tokens are code points, not UTF-8 bytes. tmux reads `0xNN` as a
 * Unicode code point, so the original's per-byte tokens turned non-ASCII
 * text inside an ESC sequence into mojibake (`é` → 0xc3 0xa9 → `Ã©`), and its
 * per-UTF-16-unit encoding turned each surrogate half into U+FFFD. ASCII,
 * the only content of hex runs and of every key or reply sequence, encodes
 * exactly as before.
 *
 * tomux: the original built one command per run. Here a run that does not
 * fit in one command is split at the cap: hex runs are plain ASCII text with
 * no meaning across the split. An ESC sequence is split only when it alone
 * exceeds the cap (more than ~200 characters, i.e. a long OSC/DCS/APC
 * string), where keeping the cap wins over atomicity; such strings never
 * come from a keyboard or a frontend reply.
 */
function pushHexCommands(commands: string[], paneId: string, text: string): void {
    const prefix = `send-keys -t ${paneId}`;
    let current = prefix;
    for (const ch of text) {   // iterates by code point
        let cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xd800 && cp <= 0xdfff) { cp = 0xfffd; }   // lone surrogate
        const token = ` 0x${cp.toString(16).padStart(2, '0')}`;
        if (current !== prefix && current.length + token.length > MAX_SEND_KEYS_COMMAND_BYTES) {
            commands.push(current);
            current = prefix;
        }
        current += token;
    }
    if (current !== prefix) {
        commands.push(current);
    }
}

/**
 * Push `send-keys -l -t <pane> '<text>'` for a run of non-ASCII text.
 *
 * tomux: split at the cap between code points, so no UTF-8 character or
 * surrogate pair is ever cut. The run holds only code units above 0x7f, so
 * `shellescape` adds exactly the two surrounding quotes.
 */
function pushNonAsciiCommands(commands: string[], paneId: string, text: string): void {
    const prefix = `send-keys -l -t ${paneId} `;
    const room = MAX_SEND_KEYS_COMMAND_BYTES - prefix.length - 2;
    let chunk = '';
    let chunkBytes = 0;
    for (const ch of text) {   // iterates by code point
        const bytes = utf8Length(ch);
        if (chunk && chunkBytes + bytes > room) {
            commands.push(prefix + shellescape(chunk));
            chunk = '';
            chunkBytes = 0;
        }
        chunk += ch;
        chunkBytes += bytes;
    }
    if (chunk) {
        commands.push(prefix + shellescape(chunk));
    }
}

/** UTF-8 length of one code point (lone surrogates count as U+FFFD, 3 bytes). */
function utf8Length(ch: string): number {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) { return 1; }
    if (cp < 0x800) { return 2; }
    if (cp < 0x10000) { return 3; }
    return 4;
}

