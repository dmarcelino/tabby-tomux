// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeps a tab's scrolling within the rows of the pane it shows (change
 * short-pane-scroll).
 *
 * The tab's terminal is as tall as the tab, but the pane can be shorter
 * (the window has other panes), and tmux sends the pane's output as written
 * for a terminal as tall as the pane. A scroll region (DECSTBM) of the pane's
 * height makes the terminal scroll the pane's rows as tmux does, and lines
 * scrolled off the top go to the scrollback.
 *
 * The keeper rewrites the output so that region stays in place:
 * - A program's DECSTBM gets its bottom row limited to the pane's height (a
 *   missing or 0 bottom is the pane's last row).
 * - After a sequence that gives the whole screen back as the region without
 *   the program asking for one (switching to or from the alternate screen
 *   with ?1049, ?1047 or ?47, and DECSTR), the pane's region is set again
 *   with the cursor saved and restored around it. After RIS, which puts the
 *   cursor home anyway, the region is set alone.
 * - An escape sequence cut across two chunks is held until the next chunk
 *   completes it, so a split reset is not missed.
 *
 * A height of 0 means unknown: output then passes through unchanged.
 *
 * When the pane's height changes, tmux moves the pane's lines and cursor
 * (a shorter pane pushes its top lines into the history, a taller one pulls
 * them back), and nothing of it is in the pane's output. The tab then draws
 * the pane again (`needsRedraw`).
 */
import type { PaneRows } from './tmux/layout'

/** Longest unfinished escape sequence held back for the next chunk; a longer one is let through. */
export const MAX_HELD_SEQUENCE = 64

const ESC = '\x1b'
/** DECSC, then DECRC: the cursor (and its style) saved and restored at once. */
const SAVE_CURSOR = '\x1b7'
const RESTORE_CURSOR = '\x1b8'
const FULL_REGION = '\x1b[r'
/** Modes that switch screens; xterm.js gives the new screen the whole screen as its region. */
const SCREEN_SWITCH_MODES = new Set([47, 1047, 1049])

/** A complete CSI sequence at the start: parameters, intermediates, final byte. */
const CSI = /^\x1b\[([0-?]*)([ -/]*)([@-~])/u
/** A complete other escape sequence at the start: intermediates, final byte. */
const ESCAPE = /^\x1b([ -/]*)([0-Z\\-~])/u
/** An escape sequence that the next chunk may complete. */
const UNFINISHED = /^\x1b(?:\[[0-?]*[ -/]*|[ -/]*)$/u

/**
 * Whether the tab must draw the pane again when its rows change from
 * `before` (null when unknown) to `after`: its height changed, and it is or
 * was shorter than its window. A pane as tall as its window is as tall as
 * the tab, and the tab's terminal, resized with it, moves its lines as tmux
 * does.
 */
export function needsRedraw (before: PaneRows | null, after: PaneRows): boolean {
    if (before === null) {
        return isShort(after)
    }
    return before.pane !== after.pane && (isShort(before) || isShort(after))
}

/** Shorter than its window, or the window's height is unknown. */
function isShort (rows: PaneRows): boolean {
    return rows.window === 0 || rows.pane < rows.window
}

export class PaneRowsKeeper {
    private heightValue = 0
    private held = ''

    get height (): number {
        return this.heightValue
    }

    /**
     * The pane is now `height` rows. Returns what sets the region when the
     * height changed: the pane's region, or the whole screen for 0.
     */
    setHeight (height: number): string {
        if (height === this.heightValue) {
            return ''
        }
        this.heightValue = height
        return height > 0 ? this.region() : SAVE_CURSOR + FULL_REGION + RESTORE_CURSOR
    }

    /**
     * Forgets an unfinished escape sequence held back from earlier output. A
     * redraw replaces that output, and the rest of the sequence was in output
     * the capture dropped.
     */
    discardHeld (): void {
        this.held = ''
    }

    /** What sets the region again after the terminal lost it (a resize). */
    reapply (): string {
        return this.heightValue > 0 ? this.region() : ''
    }

    /** `text` with the region kept at the pane's height. */
    process (text: string): string {
        if (this.heightValue <= 0) {
            const out = this.held + text
            this.held = ''
            return out
        }
        const input = this.held + text
        this.held = ''
        let out = ''
        let from = 0
        let esc = input.indexOf(ESC)
        while (esc >= 0) {
            const rest = input.slice(esc)
            const sequence = this.sequenceAt(rest)
            if (sequence === null) {
                if (UNFINISHED.test(rest) && rest.length <= MAX_HELD_SEQUENCE) {
                    this.held = rest
                    return out + input.slice(from, esc)
                }
                // Not a sequence this step knows (or too long to hold): as it is.
                esc = input.indexOf(ESC, esc + 1)
                continue
            }
            out += input.slice(from, esc) + sequence.replacement
            from = esc + sequence.length
            esc = input.indexOf(ESC, from)
        }
        return out + input.slice(from)
    }

    private region (): string {
        return SAVE_CURSOR + `\x1b[1;${this.heightValue}r` + RESTORE_CURSOR
    }

    /** The complete escape sequence at the start of `text` and what to write for it, or null. */
    private sequenceAt (text: string): { length: number, replacement: string } | null {
        if (text[1] === '[') {
            const csi = CSI.exec(text)
            if (!csi) {
                return null
            }
            const [whole, params, intermediates, final] = csi
            return { length: whole.length, replacement: this.csi(whole, params, intermediates, final) }
        }
        const escape = ESCAPE.exec(text)
        if (!escape) {
            return null
        }
        const [whole, intermediates, final] = escape
        // RIS: the whole screen is the region and the cursor is home.
        const replacement = intermediates === '' && final === 'c' ? whole + `\x1b[1;${this.heightValue}r` : whole
        return { length: whole.length, replacement }
    }

    private csi (whole: string, params: string, intermediates: string, final: string): string {
        // DECSTBM, not XTRESTORE (CSI ? … r) nor sequences with intermediates (CSI … $ r).
        if (final === 'r' && intermediates === '' && /^[\d;]*$/u.test(params)) {
            const [top, bottom] = params.split(';').map(p => Number(p) || 0)
            const limited = !bottom ? this.heightValue : Math.min(bottom, this.heightValue)
            return `\x1b[${top || 1};${limited}r`
        }
        // Screen switches: the new screen's region is the whole screen.
        if ((final === 'h' || final === 'l') && intermediates === '' && params.startsWith('?') &&
            params.slice(1).split(';').some(p => SCREEN_SWITCH_MODES.has(Number(p)))) {
            return whole + this.region()
        }
        // DECSTR (soft reset): the region is the whole screen again.
        if (final === 'p' && intermediates === '!' && !/^[<=>?]/u.test(params)) {
            return whole + this.region()
        }
        return whole
    }
}
