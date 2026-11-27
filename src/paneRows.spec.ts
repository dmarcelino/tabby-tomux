// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { MAX_HELD_SEQUENCE, needsRedraw, PaneRowsKeeper } from './paneRows'

/** The 11-row pane's region, with the cursor saved and restored around it. */
const REGION_11 = '\x1b7\x1b[1;11r\x1b8'

function keeper (height = 11): PaneRowsKeeper {
    const k = new PaneRowsKeeper()
    k.setHeight(height)
    return k
}

describe('PaneRowsKeeper', () => {
    it('passes everything through while the height is unknown', () => {
        const k = new PaneRowsKeeper()
        for (const text of ['\x1b[r', '\x1b[?1049h', '\x1bc', '\x1b[!p', 'plain\r\n', '\x1b[']) {
            expect(k.process(text)).toBe(text)
        }
        expect(k.reapply()).toBe('')
    })

    it('sets the region when the height changes, and only then', () => {
        const k = new PaneRowsKeeper()
        expect(k.setHeight(11)).toBe(REGION_11)
        expect(k.setHeight(11)).toBe('')
        expect(k.setHeight(25)).toBe('\x1b7\x1b[1;25r\x1b8')
        expect(k.height).toBe(25)
    })

    it('gives the whole screen back when the height becomes unknown', () => {
        const k = keeper()
        expect(k.setHeight(0)).toBe('\x1b7\x1b[r\x1b8')
        expect(k.process('\x1b[r')).toBe('\x1b[r')
    })

    it('re-applies the region on request (a resize cleared it)', () => {
        expect(keeper().reapply()).toBe(REGION_11)
    })

    it('leaves text and other sequences alone', () => {
        const text = 'a\r\nb\x1b[2J\x1b[H\x1b[1;31mred\x1b[0m\x1b(B\x1b]0;title\x07\x1b[?25l\x1b7\x1b8'
        expect(keeper().process(text)).toBe(text)
    })

    it('limits a program\'s DECSTBM to the pane\'s rows', () => {
        const k = keeper()
        expect(k.process('\x1b[r')).toBe('\x1b[1;11r')
        expect(k.process('\x1b[;r')).toBe('\x1b[1;11r')
        expect(k.process('\x1b[0;0r')).toBe('\x1b[1;11r')
        expect(k.process('\x1b[3r')).toBe('\x1b[3;11r')
        expect(k.process('\x1b[2;5r')).toBe('\x1b[2;5r')
        expect(k.process('\x1b[2;25r')).toBe('\x1b[2;11r')
        expect(k.process('x\x1b[1;24ry')).toBe('x\x1b[1;11ry')
    })

    it('leaves XTRESTORE and DECSTBM look-alikes with intermediates alone', () => {
        const k = keeper()
        for (const text of ['\x1b[?1049r', '\x1b[?r', '\x1b[1;2;3;4;5$r', '\x1b[>1r', '\x1b[1:2r']) {
            expect(k.process(text)).toBe(text)
        }
    })

    it('sets the region again after a screen switch, set or reset, alone or in a list', () => {
        const k = keeper()
        for (const mode of ['?1049', '?1047', '?47']) {
            expect(k.process(`\x1b[${mode}h`)).toBe(`\x1b[${mode}h` + REGION_11)
            expect(k.process(`\x1b[${mode}l`)).toBe(`\x1b[${mode}l` + REGION_11)
        }
        expect(k.process('\x1b[?25;1049hX')).toBe('\x1b[?25;1049h' + REGION_11 + 'X')
        // Not a screen switch: other private modes, and ANSI mode 47.
        expect(k.process('\x1b[?1048h\x1b[?10490h\x1b[47h')).toBe('\x1b[?1048h\x1b[?10490h\x1b[47h')
    })

    it('sets the region again after a soft reset (DECSTR)', () => {
        expect(keeper().process('\x1b[!p$ ')).toBe('\x1b[!p' + REGION_11 + '$ ')
    })

    it('sets the region after a full reset (RIS), without saving the cursor', () => {
        expect(keeper().process('\x1bc$ ')).toBe('\x1bc\x1b[1;11r$ ')
        // ESC ( c is a charset designation, not RIS.
        expect(keeper().process('\x1b(c')).toBe('\x1b(c')
    })

    it('holds an escape sequence cut across two chunks until it is complete', () => {
        const k = keeper()
        expect(k.process('line\x1b[')).toBe('line')
        expect(k.process('r')).toBe('\x1b[1;11r')
        expect(k.process('a\x1b')).toBe('a')
        expect(k.process('c')).toBe('\x1bc\x1b[1;11r')
        expect(k.process('\x1b[?10')).toBe('')
        expect(k.process('49')).toBe('')
        expect(k.process('h')).toBe('\x1b[?1049h' + REGION_11)
        expect(k.process('\x1b[!')).toBe('')
        expect(k.process('p')).toBe('\x1b[!p' + REGION_11)
    })

    it('uses the height at the time the held sequence completes', () => {
        const k = keeper()
        expect(k.process('\x1b[')).toBe('')
        k.setHeight(7)
        expect(k.process('r')).toBe('\x1b[1;7r')
    })

    it('lets an unfinished sequence longer than the limit through as it is', () => {
        const k = keeper()
        const atLimit = '\x1b[' + ';'.repeat(MAX_HELD_SEQUENCE - 2)
        expect(atLimit.length).toBe(MAX_HELD_SEQUENCE)
        expect(k.process(atLimit)).toBe('')
        expect(k.process('r')).toBe('\x1b[1;11r')
        const tooLong = atLimit + '1'
        expect(k.process(tooLong)).toBe(tooLong)
        expect(k.process('r')).toBe('r')
    })

    it('does not hold an escape that cannot start a sequence', () => {
        expect(keeper().process('a\x1b\r\n')).toBe('a\x1b\r\n')
    })

    it('forgets a held sequence on request (a redraw replaces the output it came from)', () => {
        const k = keeper()
        expect(k.process('a\x1b[1;')).toBe('a')
        k.discardHeld()
        expect(k.process('\x1b[H')).toBe('\x1b[H')
    })

    it('lets held text through when the height becomes unknown', () => {
        const k = keeper()
        expect(k.process('\x1b[')).toBe('')
        k.setHeight(0)
        expect(k.process('r')).toBe('\x1b[r')
    })
})

describe('needsRedraw', () => {
    it('when a pane shorter than its window changes height, or a pane becomes shorter', () => {
        expect(needsRedraw({ pane: 11, window: 25 }, { pane: 25, window: 25 })).toBe(true)   // zoom, other pane closed
        expect(needsRedraw({ pane: 25, window: 25 }, { pane: 11, window: 25 })).toBe(true)   // unzoom, split
        expect(needsRedraw({ pane: 11, window: 25 }, { pane: 8, window: 20 })).toBe(true)    // tab made shorter
        expect(needsRedraw({ pane: 11, window: 25 }, { pane: 13, window: 30 })).toBe(true)   // tab made taller
    })

    it('not when the height did not change', () => {
        expect(needsRedraw({ pane: 11, window: 25 }, { pane: 11, window: 25 })).toBe(false)
        expect(needsRedraw({ pane: 11, window: 25 }, { pane: 11, window: 30 })).toBe(false)
    })

    it('not for a pane as tall as its window before and after (one pane, zoomed): the tab\'s resize follows it', () => {
        expect(needsRedraw({ pane: 25, window: 25 }, { pane: 30, window: 30 })).toBe(false)
    })

    it('when the window\'s height is unknown', () => {
        expect(needsRedraw({ pane: 25, window: 0 }, { pane: 30, window: 30 })).toBe(true)
        expect(needsRedraw({ pane: 25, window: 25 }, { pane: 30, window: 0 })).toBe(true)
    })

    it('from unknown rows, only for a shorter pane', () => {
        expect(needsRedraw(null, { pane: 25, window: 25 })).toBe(false)
        expect(needsRedraw(null, { pane: 12, window: 25 })).toBe(true)
    })
})
