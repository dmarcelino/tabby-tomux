// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TomuxPaneSession } from './paneSession'
import { renderCapture } from './paneRedraw'
import { TomuxConnection } from './tmux/connection'
import type { TmuxPaneCapture } from './tmux/controlClient'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'

// A pane shorter than its tab (change short-pane-scroll), checked in xterm.js
// itself (Tabby's terminal emulator, run headless). The tab is a 25-row
// terminal fed what the pane session writes. tmux's view of the pane is a
// terminal as tall as the pane fed the same output; it also answers the
// session's captures. The tab's top rows must match it, and its rows below
// the pane stay empty.

// tabby-terminal needs Tabby's Angular runtime; a minimal BaseSession is enough
// here. vi.mock is hoisted above the imports.
vi.mock('tabby-terminal', () => ({
    BaseSession: class {
        open = false
        constructor (protected logger: unknown) {}
        readonly emitted: string[] = []
        emitOutput (data: Buffer): void { this.emitted.push(data.toString('utf-8')) }
        async destroy (): Promise<void> { /* nothing to release */ }
    },
}))

const COLS = 40
const TAB_ROWS = 25
const DEFAULT_MODES = { cursorVisible: true, mouseMode: null, mouseEncoding: null } as const
const STATE = '#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{alternate_on}|#{alternate_saved_x}|#{alternate_saved_y}|#{history_size}|#{cursor_flag}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}|#{window_height}'
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }

function write (term: Terminal, data: string): Promise<void> {
    return new Promise<void>(resolve => term.write(data, resolve))
}

function newTerminal (rows: number): Terminal {
    return new Terminal({ cols: COLS, rows, scrollback: 1000, allowProposedApi: true })
}

function screen (term: Terminal): string[] {
    const buffer = term.buffer.active
    return Array.from({ length: term.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '')
}

function scrollback (term: Terminal): string[] {
    const buffer = term.buffer.active
    return Array.from({ length: buffer.baseY }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
}

function lines (prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)
}

/** A shell running `cmd`, which prints `out`, then the next prompt. */
function command (cmd: string, out: string[]): string {
    return `${cmd}\r\n` + out.map(l => l + '\r\n').join('') + '$ '
}

/** A pane whose shell printed `history` and then a prompt on the pane's last row, as tmux captures it. */
function captureAtLastRow (height: number, history: string[]): TmuxPaneCapture {
    return {
        text: [...history, '$ '].join('\n'),
        cursorX: 2,
        cursorY: height - 1,
        paneWidth: COLS,
        paneHeight: height,
        windowHeight: TAB_ROWS,
        modes: DEFAULT_MODES,
    }
}

/** `%output` data as tmux sends it: control characters and backslashes in octal. */
function encodeOutput (text: string): string {
    return text.replace(/[\x00-\x1f\\]/gu, c => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))
}

/** A classic layout string: pane %0 of `pane` rows, above pane %1 when it is shorter than the window. */
function layout (pane: number, window: number): string {
    return pane === window
        ? `0000,${COLS}x${window},0,0,0`
        : `0000,${COLS}x${window},0,0[${COLS}x${pane},0,0,0,${COLS}x${window - pane - 1},0,${pane + 1},1]`
}

/**
 * A tab bound to pane `paneId` through a real `TomuxPaneSession`, and tmux's
 * view of that pane.
 */
class Harness {
    readonly tab = newTerminal(TAB_ROWS)
    pane: Terminal
    private written = 0
    private windowRows = TAB_ROWS

    private constructor (
        readonly tmux: FakeTmux,
        readonly session: TomuxPaneSession & { emitted: string[] },
        private paneId: string,
        pane: Terminal,
    ) {
        this.pane = pane
    }

    /** A tab adopting a window whose pane is `capture`, with tmux's `pane-border-status`. */
    static async adopt (capture: TmuxPaneCapture, borderStatus = 'off'): Promise<Harness> {
        const tmux = new FakeTmux()
        tmux.overrides.set('display-message -p -t %0 "#{pane-border-status}"', [borderStatus])
        const conn = await TomuxConnection.open(tmux, 'main')
        const pane = newTerminal(capture.paneHeight)
        await write(pane, renderCapture(capture))
        const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as any
        const harness = new Harness(tmux, session, '%0', pane)
        harness.windowRows = capture.windowHeight
        harness.answerCaptures()
        await session.start({ adopt: true })
        await harness.flush()
        return harness
    }

    /** The pane's program prints `text`. */
    async output (text: string): Promise<void> {
        await write(this.pane, text)
        this.tmux.channel.send(`%output ${this.paneId} ${encodeOutput(text)}\r\n`)
        await this.flush()
    }

    /**
     * tmux makes the pane `pane` rows in a window of `window` rows (a split,
     * a pane closed, zoom, the window resized) and sends the layout change.
     */
    async layout (pane: number, window: number, visible = layout(pane, window)): Promise<void> {
        this.pane.resize(COLS, pane)
        this.windowRows = window
        this.answerCaptures()
        this.tmux.channel.send(`%layout-change @0 ${layout(pane, window)} ${visible} *\r\n`)
        await this.flush()
    }

    /** tmux sends a layout change that leaves the pane as it is. */
    async sameLayout (layoutString: string): Promise<void> {
        this.tmux.channel.send(`%layout-change @0 ${layoutString} ${layoutString} *\r\n`)
        await this.flush()
    }

    /** Tabby resizes the tab. */
    async resize (rows: number): Promise<void> {
        this.tab.resize(COLS, rows)
        this.session.resize(COLS, rows)
        await this.flush()
    }

    /** tmux's active pane changes to `pane`, shown as `paneId`. */
    async switchPane (paneId: string, pane: Terminal): Promise<void> {
        this.paneId = paneId
        this.pane = pane
        this.answerCaptures()
        this.session.switchPane(paneId)
        await this.flush()
    }

    /**
     * The tab's top rows and cursor are the pane's, its rows below are
     * empty, and its scrollback is the pane's.
     */
    expectMatch (): void {
        const height = this.pane.rows
        expect(screen(this.tab).slice(0, height)).toEqual(screen(this.pane))
        expect(screen(this.tab).slice(height).filter(row => row !== '')).toEqual([])
        expect([this.tab.buffer.active.cursorX, this.tab.buffer.active.cursorY])
            .toEqual([this.pane.buffer.active.cursorX, this.pane.buffer.active.cursorY])
        expect(scrollback(this.tab)).toEqual(scrollback(this.pane))
    }

    /** The next capture of the pane answers with what tmux's view of it holds now. */
    private answerCaptures (): void {
        const buffer = this.pane.buffer.active
        const all = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
        this.tmux.overrides.set(`capture-pane -p -e -J -S - -t ${this.paneId}`, all)
        this.tmux.overrides.set(`display-message -p -t ${this.paneId} "${STATE}"`, [
            `${buffer.cursorX}|${buffer.cursorY}|${COLS}|${this.pane.rows}|0|4294967295|4294967295|${buffer.baseY}|1|0|0|0|0|0|${this.windowRows}`,
        ])
    }

    /** Lets tmux's replies arrive, then writes what the session wrote since last time to the tab. */
    private async flush (): Promise<void> {
        await settle(60)
        const text = this.session.emitted.slice(this.written).join('')
        this.written = this.session.emitted.length
        await write(this.tab, text)
    }
}

/**
 * The tab before this change: the redraw gives the whole tab back as the
 * scroll region, and output passes through as it is.
 */
async function tabBeforeChange (capture: TmuxPaneCapture, ...outputs: string[]): Promise<Terminal> {
    const tab = newTerminal(TAB_ROWS)
    await write(tab, renderCapture(capture) + '\x1b7\x1b[r\x1b8')
    for (const output of outputs) {
        await write(tab, output)
    }
    return tab
}

/** Whether `tab` shows `pane` on its top rows, with the cursor on the pane's row. */
function showsPane (tab: Terminal, pane: Terminal): boolean {
    const rows = screen(tab)
    return JSON.stringify(rows.slice(0, pane.rows)) === JSON.stringify(screen(pane)) &&
        rows.slice(pane.rows).every(row => row === '') &&
        tab.buffer.active.cursorY === pane.buffer.active.cursorY
}

describe('a pane shorter than the tab, in xterm.js', () => {
    const HISTORY = lines('old', 20)

    describe('new lines on the pane\'s last row', () => {
        const OUTPUT = [command('echo one', ['one']), command('echo two', ['two'])]

        it('scroll the pane\'s rows, and the lines that leave the top go to the scrollback in order', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            for (const output of OUTPUT) {
                await h.output(output)
            }
            h.expectMatch()
            expect(screen(h.tab).slice(0, 11)).toEqual([...HISTORY.slice(-6), '$ echo one', 'one', '$ echo two', 'two', '$ '])
            expect(scrollback(h.tab)).toEqual(HISTORY.slice(0, 14))
        })

        it('went below the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            for (const output of OUTPUT) {
                await h.output(output)
            }
            expect(showsPane(await tabBeforeChange(captureAtLastRow(11, HISTORY), ...OUTPUT), h.pane)).toBe(false)
        })
    })

    it('a window with one pane scrolls at the tab\'s last row, as before this change', async () => {
        const history = lines('old', 40)
        const capture = captureAtLastRow(TAB_ROWS, history)
        const output = command('seq 40', lines('', 40))
        const h = await Harness.adopt(capture)
        await h.output(output)
        h.expectMatch()
        expect(scrollback(h.tab).slice(0, history.length)).toEqual(history)
        const before = await tabBeforeChange(capture, output)
        expect(screen(before)).toEqual(screen(h.tab))
        expect(scrollback(before)).toEqual(scrollback(h.tab))
    })

    describe('a program\'s scroll region of rows 2 to 5, then a reset', () => {
        const PROGRAM = '\x1b[2;5r\x1b[5;1Ha\r\nb\r\nc\r\nd' +   // scrolls rows 2 to 5
            '\x1b[r' +                                              // reset: the cursor goes home
            '\x1b[11;1H' + lines('x', 4).join('\r\n')               // the pane's last row, then 3 new lines

        it('the program\'s region scrolls as it set it, and after the reset the pane\'s rows scroll', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(PROGRAM)
            h.expectMatch()
            // Rows 2 to 5 scrolled 3 times ('a' was written over old15), then
            // the pane's rows 3 times.
            expect(screen(h.tab).slice(0, 11)).toEqual(['c', 'd', 'old16', 'old17', 'old18', 'old19', 'old20', 'x1', 'x2', 'x3', 'x4'])
            expect(scrollback(h.tab).slice(-3)).toEqual(['old11', 'ald15', 'b'])
        })

        it('went below the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(PROGRAM)
            expect(showsPane(await tabBeforeChange(captureAtLastRow(11, HISTORY), PROGRAM), h.pane)).toBe(false)
        })
    })

    describe('a full-screen program entered and exited', () => {
        const ENTER = '\x1b[?1049h\x1b[H\x1b[2J' + lines('full', 15).join('\r\n')
        const EXIT = '\x1b[?1049l\r\n$ ls\r\nfile\r\n$ '

        it('scrolls the pane\'s rows while it runs and after it exits', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(ENTER)
            expect(h.tab.buffer.active.type).toBe('alternate')
            h.expectMatch()
            await h.output(EXIT)
            expect(h.tab.buffer.active.type).toBe('normal')
            h.expectMatch()
        })

        it('went below the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(ENTER)
            expect(showsPane(await tabBeforeChange(captureAtLastRow(11, HISTORY), ENTER), h.pane)).toBe(false)
            await h.output(EXIT)
            expect(showsPane(await tabBeforeChange(captureAtLastRow(11, HISTORY), ENTER, EXIT), h.pane)).toBe(false)
        })
    })

    describe('the tab resized, then output', () => {
        const OUTPUT = command('seq 20', lines('', 20))

        it('made taller: the pane\'s rows at its new height', async () => {
            // Tabby makes the tab 30 rows; tmux follows and the pane becomes 13 rows.
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.resize(30)
            await h.layout(13, 30)
            h.expectMatch()
            await h.output(OUTPUT)
            h.expectMatch()
        })

        it('made shorter: the pane\'s rows at its new height', async () => {
            // Tabby makes the tab 20 rows; tmux follows and the pane becomes 8 rows.
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.resize(20)
            await h.layout(8, 20)
            h.expectMatch()
            await h.output(OUTPUT)
            h.expectMatch()
        })

        it('went below the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.resize(30)
            await h.layout(13, 30)
            await h.output(OUTPUT)
            const before = await tabBeforeChange(captureAtLastRow(11, HISTORY))
            before.resize(COLS, 30)
            await write(before, OUTPUT)
            expect(showsPane(before, h.pane)).toBe(false)
        })
    })

    describe('the other pane closed', () => {
        it('the tab shows the pane at its new height, and scrolls at its last row', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(command('echo one', ['one']))
            await h.layout(TAB_ROWS, TAB_ROWS)
            h.expectMatch()
            await h.output(command('seq 30', lines('', 30)))
            h.expectMatch()
            expect(screen(h.tab)[TAB_ROWS - 1]).toBe('$ ')
        })

        it('differed from the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            await h.output(command('echo one', ['one']))
            await h.layout(TAB_ROWS, TAB_ROWS)
            const before = await tabBeforeChange(captureAtLastRow(11, HISTORY), command('echo one', ['one']))
            expect(showsPane(before, h.pane)).toBe(false)
        })
    })

    describe('zoom and unzoom', () => {
        it('zoomed, the tab scrolls at its last row; unzoomed, within the pane\'s rows again', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            // Zoomed: the visible layout shows the pane at the window's size.
            await h.layout(TAB_ROWS, TAB_ROWS)
            h.expectMatch()
            await h.output(command('seq 30', lines('Z', 30)))
            h.expectMatch()
            await h.layout(11, TAB_ROWS)
            h.expectMatch()
            await h.output(command('echo hi', ['hi']))
            h.expectMatch()
            expect(screen(h.tab).slice(8, 11)).toEqual(['$ echo hi', 'hi', '$ '])
        })

        it('unzoomed, output went below the pane before this change', async () => {
            const h = await Harness.adopt(captureAtLastRow(11, HISTORY))
            const zoomed = command('seq 30', lines('Z', 30))
            await h.layout(TAB_ROWS, TAB_ROWS)
            await h.output(zoomed)
            await h.layout(11, TAB_ROWS)
            await h.output(command('echo hi', ['hi']))
            const before = await tabBeforeChange(captureAtLastRow(11, HISTORY), zoomed, command('echo hi', ['hi']))
            expect(showsPane(before, h.pane)).toBe(false)
        })
    })

    it('with the pane border status line on top: the pane\'s rows scroll, not its cell\'s', async () => {
        // tmux: an 11-row pane under the status line, in a 12-row cell.
        const h = await Harness.adopt(captureAtLastRow(11, HISTORY), 'top')
        await h.sameLayout(layout(12, TAB_ROWS))
        expect(h.tmux.channel.commands.filter(c => c.startsWith('capture-pane'))).toHaveLength(1)
        await h.output(command('echo one', ['one']))
        h.expectMatch()
    })

    describe('a pane switch from 7 rows to 17', () => {
        it('the tab shows the 17-row pane on its top 17 rows and scrolls within them', async () => {
            const h = await Harness.adopt(captureAtLastRow(7, HISTORY))
            const other = newTerminal(17)
            await write(other, renderCapture(captureAtLastRow(17, lines('other', 30))))
            await h.switchPane('%1', other)
            h.expectMatch()
            await h.output(command('seq 20', lines('', 20)))
            h.expectMatch()
        })

        it('went below the pane before this change', async () => {
            const capture = captureAtLastRow(17, lines('other', 30))
            const pane = newTerminal(17)
            await write(pane, renderCapture(capture))
            const output = command('seq 20', lines('', 20))
            await write(pane, output)
            const before = await tabBeforeChange(captureAtLastRow(7, HISTORY))
            await write(before, '\x1b[?1049l\x1b[0m\x1b[2J\x1b[3J\x1b[H' + renderCapture(capture) + '\x1b7\x1b[r\x1b8' + output)
            expect(showsPane(before, pane)).toBe(false)
        })
    })
})
