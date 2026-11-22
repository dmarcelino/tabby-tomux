// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { PaneOutputNormalizer } from './paneOutput'

describe('PaneOutputNormalizer', () => {
    it('passes a bare LF through unchanged (raw-mode cursor down, same column)', () => {
        const n = new PaneOutputNormalizer()
        expect(n.normalize('RAW1\nRAW2')).toBe('RAW1\nRAW2')
        expect(n.normalize('\n\n')).toBe('\n\n')
    })

    it('keeps cooked-mode CRLF and a CR split from its LF as they are', () => {
        const n = new PaneOutputNormalizer()
        expect(n.normalize('a\r\nb\r\n')).toBe('a\r\nb\r\n')
        expect(n.normalize('line\r')).toBe('line\r')
        expect(n.normalize('\nnext\n')).toBe('\nnext\n')
    })

    it('strips screen/tmux title sequences', () => {
        expect(new PaneOutputNormalizer().normalize('a\x1bkvim\x1b\\b')).toBe('ab')
    })

    it('strips DSR and DA queries tmux already answers', () => {
        const n = new PaneOutputNormalizer()
        expect(n.normalize('x\x1b[6ny\x1b[cz\x1b[>0c')).toBe('xyz')
    })

    it('strips OSC 10/11 colour responses with BEL or ST', () => {
        const n = new PaneOutputNormalizer()
        expect(n.normalize('a\x1b]10;rgb:ffff/ffff/ffff\x07b\x1b]11;rgb:0000/0000/0000\x1b\\c')).toBe('abc')
    })

    it('keeps other escape sequences intact', () => {
        const colored = '\x1b[38;5;154mhi\x1b[0m\x1b[H\x1b[?2004h'
        expect(new PaneOutputNormalizer().normalize(colored)).toBe(colored)
    })

    it('reset keeps output unchanged (there is no line-ending state)', () => {
        const n = new PaneOutputNormalizer()
        n.normalize('x\r')
        n.reset()
        expect(n.normalize('\n')).toBe('\n')
    })
})
