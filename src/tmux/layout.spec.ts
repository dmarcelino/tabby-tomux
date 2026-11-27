// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { paneCellInLayout, paneRows, paneRowsInLayout } from './layout'

/** The pane's height alone. */
function paneHeightInLayout (layout: string, paneNumber: number): number | null {
    return paneRowsInLayout(layout, paneNumber)?.pane ?? null
}

describe('paneRowsInLayout', () => {
    it('one pane: the window\'s size', () => {
        expect(paneRowsInLayout('ba1d,97x25,0,0,0', 0)).toEqual({ pane: 25, window: 25 })
    })

    it('two stacked panes (as tmux 3.8 sent them)', () => {
        const layout = '928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]'
        expect(paneRowsInLayout(layout, 0)).toEqual({ pane: 12, window: 25 })
        expect(paneRowsInLayout(layout, 1)).toEqual({ pane: 12, window: 25 })
    })

    it('panes side by side', () => {
        const layout = 'a1b2,97x25,0,0{48x25,0,0,3,48x25,49,0,4}'
        expect(paneHeightInLayout(layout, 3)).toBe(25)
        expect(paneHeightInLayout(layout, 4)).toBe(25)
    })

    it('nested containers', () => {
        // %5 on the left, %6 above %7 on the right, and %8 below all of them.
        const layout = 'c3d4,97x25,0,0[97x17,0,0{48x17,0,0,5,48x17,49,0[48x7,49,0,6,48x9,49,8,7]},97x7,0,18,8]'
        expect(paneHeightInLayout(layout, 5)).toBe(17)
        expect(paneHeightInLayout(layout, 6)).toBe(7)
        expect(paneHeightInLayout(layout, 7)).toBe(9)
        expect(paneHeightInLayout(layout, 8)).toBe(7)
        expect(paneRowsInLayout(layout, 6)?.window).toBe(25)
    })

    it('a zoomed window: the visible layout has the zoomed pane alone, at the window\'s size (as tmux 3.8 sent it)', () => {
        const layout = 'be58,40x25,0,0[40x12,0,0,0,40x12,0,13,1]'
        const visible = 'b55d,40x25,0,0,0'
        expect(paneRowsInLayout(layout, 0)).toEqual({ pane: 12, window: 25 })
        expect(paneRowsInLayout(visible, 0)).toEqual({ pane: 25, window: 25 })
        expect(paneRowsInLayout(visible, 1)).toBeNull()
    })

    it('a pane that is not in the layout', () => {
        expect(paneHeightInLayout('928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]', 2)).toBeNull()
    })

    it('does not take a container\'s position for a pane number', () => {
        // The container's X,Y are 0,0: there is no pane %0 here.
        expect(paneHeightInLayout('928d,97x25,0,0[97x12,0,0,3,97x12,0,13,4]', 0)).toBeNull()
    })

    it('malformed strings', () => {
        for (const layout of [
            '',
            'garbage',
            '97x25,0,0,0',                                  // no checksum
            'zz,97x25,0,0,0',                               // checksum not hex
            '928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1',      // container not closed
            '928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1}',     // wrong closing bracket
            '928d,97x25,0,0,0 trailing',
            '928d,97x25,0,0',                               // no pane number
            '928d,97x25,0,0[]',                             // empty container
            '{"cells":[]}',                                 // not the classic format
        ]) {
            expect(paneHeightInLayout(layout, 0), layout).toBeNull()
        }
    })

    describe('with the pane border status line (pane-border-status)', () => {
        // The layout tmux 3.8 printed (as JSON) for %0 and %3 side by side on
        // top, %1 and %2 below; the expected heights are tmux's pane_height.
        const LAYOUT = 'abcd,40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,3},40x6,0,13,1,40x5,0,20,2]'

        it('at the top: one row fewer for the panes at the window\'s top edge (tmux: 11, 11, 6, 5)', () => {
            expect([0, 3, 1, 2].map(n => paneRowsInLayout(LAYOUT, n, 'top')?.pane)).toEqual([11, 11, 6, 5])
        })

        it('at the bottom: one row fewer for the pane at the window\'s bottom edge (tmux: 12, 12, 6, 4)', () => {
            expect([0, 3, 1, 2].map(n => paneRowsInLayout(LAYOUT, n, 'bottom')?.pane)).toEqual([12, 12, 6, 4])
        })

        it('a zoomed or only pane touches both edges (tmux: 24 of 25)', () => {
            expect(paneRowsInLayout('b55d,40x25,0,0,3', 3, 'top')).toEqual({ pane: 24, window: 25 })
            expect(paneRowsInLayout('b55d,40x25,0,0,3', 3, 'bottom')).toEqual({ pane: 24, window: 25 })
            expect(paneRowsInLayout('b55d,40x25,0,0,3', 3, 'off')).toEqual({ pane: 25, window: 25 })
        })

        it('keeps the cell, so the rows can be worked out later', () => {
            const cell = paneCellInLayout(LAYOUT, 2)
            expect(cell).toEqual({ height: 5, atTop: false, atBottom: true, window: 25 })
            expect(paneRows(cell!, 'bottom')).toEqual({ pane: 4, window: 25 })
        })
    })
})
