// SPDX-License-Identifier: GPL-3.0-only
/**
 * Pane sizes from tmux's classic layout string, the one `%layout-change`
 * sends in control mode (tmux 3.8 too):
 *
 *     <checksum>,<cell>
 *     cell = WxH,X,Y,<pane number>      a pane
 *          | WxH,X,Y{cell,cell,...}     panes side by side
 *          | WxH,X,Y[cell,cell,...]     panes stacked
 *
 * e.g. `928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]`: a 97x25 window with pane
 * %0 (12 rows) above pane %1 (12 rows).
 *
 * A cell's height includes the row of the pane border status line
 * (`pane-border-status top` or `bottom`) when tmux draws it inside the cell:
 * for a cell at the window's top or bottom edge (tmux 3.8, `layout.c`). The
 * pane is then one row shorter than its cell; `paneRows` takes it off.
 */

/** A pane's rows and its window's. */
export interface PaneRows {
    pane: number
    /** 0 when unknown. */
    window: number
}

/** Where tmux draws a status line in the pane borders (the `pane-border-status` option). */
export type PaneBorderStatus = 'off' | 'top' | 'bottom'

/** A pane's cell in a layout. */
export interface PaneCell {
    height: number
    /** At the window's top edge, or its bottom edge. */
    atTop: boolean
    atBottom: boolean
    /** The window's height. */
    window: number
}

/**
 * The cell of pane number `paneNumber` (`%N` → N) in `layout`, or null when
 * the pane is not in it or the string is not a classic layout.
 */
export function paneCellInLayout (layout: string, paneNumber: number): PaneCell | null {
    const comma = layout.indexOf(',')
    if (comma <= 0 || !/^[0-9a-f]+$/iu.test(layout.slice(0, comma))) {
        return null
    }
    const parser = new LayoutParser(layout, comma + 1)
    const cells = new Map<number, { y: number, height: number }>()
    const window = parser.cell(cells)
    if (window === null || !parser.atEnd()) {
        return null
    }
    const cell = cells.get(paneNumber)
    if (!cell) {
        return null
    }
    return {
        height: cell.height,
        atTop: cell.y === window.y,
        atBottom: cell.y + cell.height === window.y + window.height,
        window: window.height,
    }
}

/** The pane's rows in `cell`: one fewer when the border status line is drawn inside the cell. */
export function paneRows (cell: PaneCell, borderStatus: PaneBorderStatus): PaneRows {
    const statusInside = (borderStatus === 'top' && cell.atTop) || (borderStatus === 'bottom' && cell.atBottom)
    return { pane: statusInside ? cell.height - 1 : cell.height, window: cell.window }
}

/** The rows of pane number `paneNumber` in `layout` (see `paneCellInLayout` and `paneRows`). */
export function paneRowsInLayout (layout: string, paneNumber: number, borderStatus: PaneBorderStatus = 'off'): PaneRows | null {
    const cell = paneCellInLayout(layout, paneNumber)
    return cell ? paneRows(cell, borderStatus) : null
}

class LayoutParser {
    constructor (private readonly text: string, private pos: number) { }

    atEnd (): boolean {
        return this.pos === this.text.length
    }

    /** Reads one cell, recording each pane's row and height; the cell's, or null when malformed. */
    cell (cells: Map<number, { y: number, height: number }>): { y: number, height: number } | null {
        const width = this.number()
        if (width === null || !this.take('x')) {
            return null
        }
        const height = this.number()
        if (height === null || !this.take(',') || this.number() === null || !this.take(',')) {
            return null
        }
        const y = this.number()
        if (y === null) {
            return null
        }
        const cell = { y, height }
        const open = this.text[this.pos]
        if (open === '{' || open === '[') {
            this.pos++
            const close = open === '{' ? '}' : ']'
            do {
                if (this.cell(cells) === null) {
                    return null
                }
            } while (this.take(','))
            return this.take(close) ? cell : null
        }
        if (!this.take(',')) {
            return null
        }
        const pane = this.number()
        if (pane === null) {
            return null
        }
        cells.set(pane, cell)
        return cell
    }

    private number (): number | null {
        const match = /^\d+/u.exec(this.text.slice(this.pos))
        if (!match) {
            return null
        }
        this.pos += match[0].length
        return Number(match[0])
    }

    private take (char: string): boolean {
        if (this.text[this.pos] === char) {
            this.pos++
            return true
        }
        return false
    }
}
