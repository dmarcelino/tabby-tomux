// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { dropTerminalReplies, encodeSendKeys, MAX_SEND_KEYS_COMMAND_BYTES } from './sendKeys'

const PANE = '%3'

/**
 * Reverse of sendKeys.ts KEY_MAP (`\n` also maps to Enter; decoded as `\r`).
 * Arrows, Home and End decode to their normal-mode form; KEY_MAP also accepts
 * the application-cursor-mode form (`ESC O …`).
 */
const KEY_NAMES: Record<string, string> = {
    Enter: '\r', BSpace: '\x7f', Escape: '\x1b', Tab: '\t',
    Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
    DC: '\x1b[3~', IC: '\x1b[2~',
    F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
    F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
    F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
}

/** Undo `shellescape`: one single-quoted word, with `'\''` for each quote. */
function unquote(word: string): string {
    expect(word.startsWith(`'`) && word.endsWith(`'`)).toBe(true)
    return word.slice(1, -1).split(`'\\''`).map(part => {
        expect(part).not.toContain(`'`)
        return part
    }).join(`'`)
}

/**
 * Decode one command back to the text tmux would type into the pane, for the
 * four formats encodeSendKeys emits. `0xNN` is read the way tmux reads it:
 * as a Unicode code point.
 */
function decodeCommand(cmd: string): string {
    let m = /^send-keys -lt %3 ([A-Za-z0-9+/):,_]+)$/.exec(cmd)
    if (m) {
        return m[1]
    }
    m = /^send-keys -l -t %3 ('.*')$/s.exec(cmd)
    if (m) {
        return unquote(m[1])
    }
    m = /^send-keys -t %3 ((?:0x[0-9a-f]{2,})(?: 0x[0-9a-f]{2,})*)$/.exec(cmd)
    if (m) {
        return m[1].split(' ').map(h => String.fromCodePoint(parseInt(h, 16))).join('')
    }
    m = /^send-keys -t %3 (\S+)$/.exec(cmd)
    if (m) {
        const key = m[1].startsWith(`'`) ? unquote(m[1]) : m[1]
        if (key in KEY_NAMES) {
            return KEY_NAMES[key]
        }
        const ctrl = /^C-(.)$/.exec(key)
        if (ctrl) {
            return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) - 64)
        }
    }
    throw new Error(`unrecognised command: ${JSON.stringify(cmd)}`)
}

function decodeAll(commands: string[]): string {
    return commands.map(decodeCommand).join('')
}

function bytes(cmd: string): number {
    return Buffer.byteLength(cmd, 'utf8')
}

describe('encodeSendKeys', () => {
    it('returns nothing for empty input', () => {
        expect(encodeSendKeys('', PANE)).toEqual([])
    })

    it('rejects anything that is not a pane id', () => {
        expect(() => encodeSendKeys('a', '%3; kill-server')).toThrow(/pane id/)
        expect(() => encodeSendKeys('a', '')).toThrow(/pane id/)
        expect(() => encodeSendKeys('a', '@3')).toThrow(/pane id/)
    })

    it('keeps both spaces in `echo a b  c` and sends Enter', () => {
        const commands = encodeSendKeys('echo a b  c\r', PANE)
        expect(commands).toEqual([
            'send-keys -lt %3 echo',
            'send-keys -t %3 0x20',
            'send-keys -lt %3 a',
            'send-keys -t %3 0x20',
            'send-keys -lt %3 b',
            'send-keys -t %3 0x20 0x20',
            'send-keys -lt %3 c',
            'send-keys -t %3 Enter',
        ])
        expect(decodeAll(commands)).toBe('echo a b  c\r')
    })

    it('sends Enter, Tab, Backspace and control keys by name', () => {
        expect(encodeSendKeys('\r\t\x7f\x03\x04\x1a', PANE)).toEqual([
            'send-keys -t %3 Enter',
            'send-keys -t %3 Tab',
            'send-keys -t %3 BSpace',
            'send-keys -t %3 C-c',
            'send-keys -t %3 C-d',
            'send-keys -t %3 C-z',
        ])
        // Bare \n is Enter too; other control characters become C-<letter>.
        expect(encodeSendKeys('\n\x01\x12', PANE)).toEqual([
            'send-keys -t %3 Enter',
            'send-keys -t %3 C-a',
            'send-keys -t %3 C-r',
        ])
        // Ctrl-\ is quoted: unquoted, tmux's parser rejects the trailing backslash.
        const ctrlBackslash = encodeSendKeys('\x1c\x1d\x1e\x1f\x00', PANE)
        expect(ctrlBackslash).toEqual([
            `send-keys -t %3 'C-\\'`,
            'send-keys -t %3 C-]',
            'send-keys -t %3 C-^',
            'send-keys -t %3 C-_',
            'send-keys -t %3 C-@',
        ])
        expect(decodeAll(ctrlBackslash)).toBe('\x1c\x1d\x1e\x1f\x00')
        // A lone ESC (no sequence after it) is the Escape key.
        expect(encodeSendKeys('\x1b', PANE)).toEqual(['send-keys -t %3 Escape'])
    })

    it('sends each arrow key as one named key, even when several arrive together', () => {
        expect(encodeSendKeys('\x1b[A\x1b[B\x1b[C\x1b[D', PANE)).toEqual([
            'send-keys -t %3 Up',
            'send-keys -t %3 Down',
            'send-keys -t %3 Right',
            'send-keys -t %3 Left',
        ])
    })

    it('sends function and editing keys by name', () => {
        expect(encodeSendKeys('\x1bOP\x1b[24~\x1b[3~\x1b[5~', PANE)).toEqual([
            'send-keys -t %3 F1',
            'send-keys -t %3 F12',
            'send-keys -t %3 DC',
            'send-keys -t %3 PageUp',
        ])
    })

    it('sends Home and End by name in application cursor mode', () => {
        expect(encodeSendKeys('\x1bOH\x1bOF', PANE)).toEqual([
            'send-keys -t %3 Home',
            'send-keys -t %3 End',
        ])
    })

    it('sends the arrow keys by name in application cursor mode', () => {
        expect(encodeSendKeys('\x1bOA\x1bOB\x1bOC\x1bOD', PANE)).toEqual([
            'send-keys -t %3 Up',
            'send-keys -t %3 Down',
            'send-keys -t %3 Right',
            'send-keys -t %3 Left',
        ])
    })

    it('keeps application-mode Home and End apart from the text around them', () => {
        // What xterm.js sends for: abc, Home, X, End, Y in vim's insert mode.
        expect(encodeSendKeys('abc\x1bOHX\x1bOFY', PANE)).toEqual([
            'send-keys -lt %3 abc',
            'send-keys -t %3 Home',
            'send-keys -lt %3 X',
            'send-keys -t %3 End',
            'send-keys -lt %3 Y',
        ])
    })

    it('hex-encodes unknown sequences atomically (other SS3 sequences, modified arrows)', () => {
        expect(encodeSendKeys('\x1bOM\x1b[1;5C', PANE)).toEqual([
            'send-keys -t %3 0x1b 0x4f 0x4d',
            'send-keys -t %3 0x1b 0x5b 0x31 0x3b 0x35 0x43',
        ])
    })

    it('sends a cursor-position report as one atomic command between its neighbours', () => {
        const commands = encodeSendKeys('a\x1b[12;40Rb', PANE)
        expect(commands).toEqual([
            'send-keys -lt %3 a',
            'send-keys -t %3 0x1b 0x5b 0x31 0x32 0x3b 0x34 0x30 0x52',
            'send-keys -lt %3 b',
        ])
        expect(decodeAll(commands)).toBe('a\x1b[12;40Rb')
    })

    it('sends OSC replies (BEL and ST terminated) atomically', () => {
        const bel = '\x1b]11;rgb:0000/0000/0000\x07'
        const st = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
        const commands = encodeSendKeys(bel + st, PANE)
        expect(commands).toHaveLength(2)
        expect(decodeCommand(commands[0])).toBe(bel)
        expect(decodeCommand(commands[1])).toBe(st)
    })

    it('hex-encodes non-ASCII inside an ESC sequence as code points (tmux reads 0xNN as one)', () => {
        const osc = '\x1b]0;café 😀\x07'
        const commands = encodeSendKeys(osc, PANE)
        expect(commands).toEqual([
            'send-keys -t %3 0x1b 0x5d 0x30 0x3b 0x63 0x61 0x66 0xe9 0x20 0x1f600 0x07',
        ])
        expect(decodeAll(commands)).toBe(osc)
    })

    it('sends bracketed paste markers atomically around the pasted text', () => {
        const input = '\x1b[200~ls -la\x1b[201~'
        const commands = encodeSendKeys(input, PANE)
        expect(commands).toEqual([
            'send-keys -t %3 0x1b 0x5b 0x32 0x30 0x30 0x7e',
            'send-keys -lt %3 ls',
            'send-keys -t %3 0x20 0x2d',
            'send-keys -lt %3 la',
            'send-keys -t %3 0x1b 0x5b 0x32 0x30 0x31 0x7e',
        ])
        expect(decodeAll(commands)).toBe(input)
    })

    it('sends non-ASCII text literally with -l', () => {
        expect(encodeSendKeys('é', PANE)).toEqual([`send-keys -l -t %3 'é'`])
        expect(encodeSendKeys('中文', PANE)).toEqual([`send-keys -l -t %3 '中文'`])
        expect(encodeSendKeys('👍🏽', PANE)).toEqual([`send-keys -l -t %3 '👍🏽'`])
        const mixed = 'café 中文 👍 ok'
        const commands = encodeSendKeys(mixed, PANE)
        expect(commands).toEqual([
            'send-keys -lt %3 caf',
            `send-keys -l -t %3 'é'`,
            'send-keys -t %3 0x20',
            `send-keys -l -t %3 '中文'`,
            'send-keys -t %3 0x20',
            `send-keys -l -t %3 '👍'`,
            'send-keys -t %3 0x20',
            'send-keys -lt %3 ok',
        ])
        expect(decodeAll(commands)).toBe(mixed)
    })

    it.each([
        ['é (2 bytes)', 'é'],
        ['中 (3 bytes)', '中'],
        ['😀 (4 bytes, surrogate pair)', '😀'],
    ])('splits a non-ASCII run at the cap without cutting a character: %s', (_label, ch) => {
        const input = ch.repeat(700)
        const commands = encodeSendKeys(input, PANE)
        expect(commands.length).toBeGreaterThan(1)
        for (const cmd of commands) {
            expect(bytes(cmd)).toBeLessThanOrEqual(MAX_SEND_KEYS_COMMAND_BYTES)
            // Each chunk is whole characters only.
            const text = decodeCommand(cmd)
            expect(text).toBe(ch.repeat([...text].length))
            expect(text).not.toContain('�')
        }
        expect(decodeAll(commands)).toBe(input)
    })

    it('fills a split non-ASCII chunk up to the cap', () => {
        // 3-byte characters: prefix 'send-keys -l -t %3 ' (19) + 2 quotes leaves
        // 1003 bytes, i.e. 334 characters per command.
        const commands = encodeSendKeys('中'.repeat(700), PANE)
        expect(commands.map(c => [...decodeCommand(c)].length)).toEqual([334, 334, 32])
    })

    it('splits long safe-literal and hex runs at the cap', () => {
        const literal = 'a'.repeat(5000)
        const litCommands = encodeSendKeys(literal, PANE)
        expect(litCommands.every(c => c.startsWith('send-keys -lt %3 '))).toBe(true)
        expect(Math.max(...litCommands.map(bytes))).toBe(MAX_SEND_KEYS_COMMAND_BYTES)
        expect(decodeAll(litCommands)).toBe(literal)

        const spaces = ' '.repeat(5000)
        const hexCommands = encodeSendKeys(spaces, PANE)
        expect(hexCommands.length).toBeGreaterThan(1)
        expect(hexCommands.every(c => bytes(c) <= MAX_SEND_KEYS_COMMAND_BYTES)).toBe(true)
        expect(decodeAll(hexCommands)).toBe(spaces)
    })

    it('quotes single quotes and shell-special characters safely', () => {
        const special = `it's "$HOME" \`x\` ; # ~ {a} \\ & | < > * ? ! %`
        const commands = encodeSendKeys(special, PANE)
        // Only the safe set goes out unquoted; everything else is hex.
        for (const cmd of commands) {
            expect(cmd).toMatch(/^send-keys (-lt %3 [A-Za-z0-9+/):,_]+|-t %3 0x[0-9a-f]{2}( 0x[0-9a-f]{2})*)$/)
        }
        expect(decodeAll(commands)).toBe(special)

        // Non-ASCII runs are single-quoted; they cannot contain a quote, but
        // the quote right next to them is still sent separately as hex.
        const quoted = `'é'`
        expect(encodeSendKeys(quoted, PANE)).toEqual([
            'send-keys -t %3 0x27',
            `send-keys -l -t %3 'é'`,
            'send-keys -t %3 0x27',
        ])
    })

    it('round-trips a 100 KB paste in order with every command within the cap', () => {
        // Deterministic mix of what a paste can hold: code, punctuation,
        // quotes, tabs, CR line ends, accents, CJK and emoji.
        const pieces = [
            'const x = { a: 1, b: [2, 3] };', `echo 'it''s' "$PATH" > /tmp/x;`, '\t',
            'naïve café', '日本語のテキスト', '🎉🚀', '\r', '#!/bin/sh', 'a_b+c/d:e,f)', '  ',
            '\\n%s~`^', '\x1b[200~', '\x1b[201~',
        ]
        let input = ''
        let seed = 42
        while (input.length < 100 * 1024) {
            seed = (seed * 1103515245 + 12345) % 2147483648
            input += pieces[seed % pieces.length]
        }
        const commands = encodeSendKeys(input, PANE)
        for (const cmd of commands) {
            expect(bytes(cmd)).toBeLessThanOrEqual(MAX_SEND_KEYS_COMMAND_BYTES)
        }
        expect(decodeAll(commands)).toBe(input)
    })

    it('splits an over-long OSC string only when it cannot fit in one command', () => {
        const osc = `\x1b]52;c;${'A'.repeat(400)}\x07`
        const commands = encodeSendKeys(osc, PANE)
        expect(commands.length).toBeGreaterThan(1)
        expect(commands.every(c => bytes(c) <= MAX_SEND_KEYS_COMMAND_BYTES)).toBe(true)
        expect(decodeAll(commands)).toBe(osc)
    })
})

describe('dropTerminalReplies', () => {
    it('drops DSR and DA replies and keeps everything else', () => {
        expect(dropTerminalReplies('ab\x1b[0nc\x1b[?1;2cd')).toBe('abcd')
        expect(dropTerminalReplies('\x1b[A\x1b[200~x\x1b[201~')).toBe('\x1b[A\x1b[200~x\x1b[201~')
    })

    it.each([
        ['\x1b[?1;2c'],
        ['\x1b[>0;276;0c'],
        ['\x1b[0n'],
        ['\x1b[3n'],
    ])('drops the reply %j', reply => {
        expect(dropTerminalReplies(`x${reply}y`)).toBe('xy')
    })

    it.each([
        ['Shift+F3', '\x1b[1;2R'],
        ['Ctrl+F3', '\x1b[1;5R'],
        ['Alt+F3', '\x1b[1;3R'],
    ])('keeps modified F3 (%s), which xterm encodes as CSI 1;<mod> R', (_label, key) => {
        expect(dropTerminalReplies(key)).toBe(key)
        // ...and it reaches the pane as one atomic hex send-keys.
        expect(encodeSendKeys(dropTerminalReplies(key), PANE)).toEqual([
            `send-keys -t ${PANE} ${[...key].map(c => '0x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')}`,
        ])
    })
})
