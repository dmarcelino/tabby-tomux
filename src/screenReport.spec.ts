// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { describeScreen, ScreenLike } from './screenReport'

/** A terminal whose buffer holds `lines` (scrollback first, then the screen). */
function screen (cols: number, rows: number, lines: string[], cursorX: number, cursorY: number): ScreenLike {
    return {
        cols,
        rows,
        buffer: {
            active: {
                cursorX,
                cursorY,
                baseY: Math.max(0, lines.length - rows),
                length: lines.length,
                getLine: (i: number) => (i < lines.length ? { translateToString: () => lines[i] } : undefined),
            },
        },
    }
}

describe('describeScreen', () => {
    it('reports size, cursor, scrollback and how many visible rows have text', () => {
        const lines = ['old 1', 'old 2', 'dario@mac ~ % ', '', '']
        expect(describeScreen(screen(80, 3, lines, 14, 0))).toBe(
            'terminal 80x3, cursor 14,0, scrollback 2 lines, visible rows with text 1/3, cursor row "dario@mac ~ %"')
    })

    it('reports a blank screen as 0 rows with text', () => {
        const lines = ['dario@mac ~ % ', '', '', '']
        expect(describeScreen(screen(80, 3, lines, 14, 2))).toBe(
            'terminal 80x3, cursor 14,2, scrollback 1 lines, visible rows with text 0/3, cursor row ""')
    })
})
