// SPDX-License-Identifier: GPL-3.0-only
/**
 * One log line describing what a terminal shows, so a restored tab that comes
 * up blank leaves evidence in Tabby's log.
 */

/** The parts of an xterm.js Terminal the report reads. */
export interface ScreenLike {
    readonly cols: number
    readonly rows: number
    readonly buffer: {
        readonly active: {
            readonly cursorX: number
            readonly cursorY: number
            readonly baseY: number
            readonly length: number
            getLine (y: number): { translateToString (trimRight?: boolean): string } | undefined
        }
    }
}

export function describeScreen (term: ScreenLike): string {
    const buf = term.buffer.active
    const rowText = (y: number): string => buf.getLine(buf.baseY + y)?.translateToString(true).trimEnd() ?? ''
    let withText = 0
    for (let y = 0; y < term.rows; y++) {
        if (rowText(y)) {
            withText++
        }
    }
    return `terminal ${term.cols}x${term.rows}, cursor ${buf.cursorX},${buf.cursorY}, ` +
        `scrollback ${buf.baseY} lines, visible rows with text ${withText}/${term.rows}, ` +
        `cursor row ${JSON.stringify(rowText(buf.cursorY))}`
}
