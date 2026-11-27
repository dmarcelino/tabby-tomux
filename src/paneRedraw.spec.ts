// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { CLEAR_SCREEN, renderCapture, renderModes } from './paneRedraw'
import type { TmuxPaneCapture } from './tmux/controlClient'

// The redraw is checked in xterm.js itself (Tabby's terminal emulator, run
// headless), followed by what the program and the shell print next.

const COLS = 40
const ROWS = 6
const DEFAULT_MODES = { cursorVisible: true, mouseMode: null, mouseEncoding: null } as const

/**
 * The shell's history (`old 1`) and screen behind Claude Code. Starting it
 * scrolled the screen, so its last row is empty, and that is where tmux saved
 * the cursor.
 */
const SHELL = ['old 1', 'old 2', 'old 3', '$ ls', 'file', '$ claude', ''].join('\n')
const CLAUDE_RUNNING: TmuxPaneCapture = {
    text: SHELL,
    cursorX: 2,
    cursorY: 4,
    paneWidth: COLS,
    paneHeight: ROWS,
    windowHeight: ROWS,
    alternate: { text: ['CLAUDE-1', 'CLAUDE-2', 'CLAUDE-3', '', '> type here', 'status'].join('\n'), savedCursor: { x: 0, y: 5 } },
    modes: { cursorVisible: false, mouseMode: 1002, mouseEncoding: 1006 },
}
/** What Claude Code prints when it exits (in fullscreen mode). */
const CLAUDE_EXIT = '\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049lResume this session\r\n$ '

async function terminalAfter (...chunks: string[]): Promise<Terminal> {
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
    for (const chunk of chunks) {
        await new Promise<void>(resolve => term.write(chunk, resolve))
    }
    return term
}

function screen (term: Terminal): string[] {
    const buffer = term.buffer.active
    return Array.from({ length: term.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '')
}

function allLines (term: Terminal): string[] {
    const buffer = term.buffer.active
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
}

function cursorHidden (term: Terminal): boolean {
    // Not in xterm.js's public API; the core service holds it.
    return (term as any)._core.coreService.isCursorHidden
}

describe('pane redraw in xterm.js', () => {
    it('restored tab: the program\'s exit brings back the shell\'s screen with nothing of the program\'s', async () => {
        const term = await terminalAfter(renderCapture(CLAUDE_RUNNING), CLAUDE_EXIT)
        expect(term.buffer.active.type).toBe('normal')
        expect(allLines(term).join('\n')).not.toContain('CLAUDE')
        expect(screen(term)).toEqual(['old 3', '$ ls', 'file', '$ claude', 'Resume this session', '$ '])
    })

    it('restored tab while the program runs: its screen on the alternate screen, cursor hidden, mouse on', async () => {
        const term = await terminalAfter(renderCapture(CLAUDE_RUNNING))
        expect(term.buffer.active.type).toBe('alternate')
        expect(screen(term)).toEqual(['CLAUDE-1', 'CLAUDE-2', 'CLAUDE-3', '', '> type here', 'status'])
        expect(term.buffer.active.cursorX).toBe(2)
        expect(term.buffer.active.cursorY).toBe(4)
        expect(cursorHidden(term)).toBe(true)
        expect(term.modes.mouseTrackingMode).toBe('drag')
    })

    it('draws the program\'s screen from the top, wherever the shell\'s cursor was', async () => {
        // The shell's cursor mid-screen, and a program screen shorter than the
        // terminal (a pane smaller than the tab): ESC[?1049h doesn't move the
        // cursor, so without a cursor home the screen would start on row 2.
        const shortScreen: TmuxPaneCapture = {
            ...CLAUDE_RUNNING,
            alternate: { text: ['PROGRAM-1', 'PROGRAM-2', 'PROGRAM-3'].join('\n'), savedCursor: { x: 0, y: 2 } },
            cursorX: 0,
            cursorY: 2,
        }
        const term = await terminalAfter(renderCapture(shortScreen))
        expect(screen(term)).toEqual(['PROGRAM-1', 'PROGRAM-2', 'PROGRAM-3', '', '', ''])
    })

    it('reconnect after the program exited while disconnected: the shell on the normal screen, cursor shown, mouse off', async () => {
        // The tab still shows the program on its alternate screen, with its modes.
        const before = renderCapture(CLAUDE_RUNNING)
        const shellNow: TmuxPaneCapture = {
            text: SHELL + 'Resume this session\n$ ', cursorX: 2, cursorY: 5, paneWidth: COLS, paneHeight: ROWS, windowHeight: ROWS, modes: DEFAULT_MODES,
        }
        const term = await terminalAfter(before, CLEAR_SCREEN + renderCapture(shellNow))
        expect(term.buffer.active.type).toBe('normal')
        expect(screen(term)).toEqual(['old 3', '$ ls', 'file', '$ claude', 'Resume this session', '$ '])
        expect(allLines(term).filter(l => l.startsWith('old'))).toEqual(['old 1', 'old 2', 'old 3'])
        expect(cursorHidden(term)).toBe(false)
        expect(term.modes.mouseTrackingMode).toBe('none')
    })

    it('reconnect while the program runs, then its exit: the shell\'s screen once, with no program text', async () => {
        const term = await terminalAfter(renderCapture(CLAUDE_RUNNING), CLEAR_SCREEN + renderCapture(CLAUDE_RUNNING), CLAUDE_EXIT)
        expect(term.buffer.active.type).toBe('normal')
        expect(allLines(term).join('\n')).not.toContain('CLAUDE')
        expect(allLines(term).filter(l => l === 'old 1')).toHaveLength(1)
    })

    it('without the fix, the same exit leaves the program\'s screen behind (the bug this guards against)', async () => {
        // What tomux drew before: only the alternate screen's capture, on the normal screen.
        const term = await terminalAfter('\x1b[0m' + CLAUDE_RUNNING.alternate!.text.replace(/\n/g, '\r\n') + '\x1b[0m\x1b[5;3H', CLAUDE_EXIT)
        expect(screen(term)[0]).toBe('Resume this session')
        expect(allLines(term).join('\n')).toContain('CLAUDE-3')
    })

    it('pane shorter than the tab, history longer than the tab: the pane\'s screen on the top rows, history in the scrollback', async () => {
        const history = Array.from({ length: 8 }, (_, i) => `old ${i + 1}`)
        const shortPane: TmuxPaneCapture = {
            text: [...history, '$ ls', 'file', '$ '].join('\n'), cursorX: 2, cursorY: 2, paneWidth: COLS, paneHeight: 3, windowHeight: ROWS, modes: DEFAULT_MODES,
        }
        const term = await terminalAfter(renderCapture(shortPane))
        expect(screen(term)).toEqual(['$ ls', 'file', '$ ', '', '', ''])
        expect(term.buffer.active.cursorX).toBe(2)
        expect(term.buffer.active.cursorY).toBe(2)
        expect(allLines(term).slice(0, 11)).toEqual([...history, '$ ls', 'file', '$ '])
        // The region stays at the pane's rows: the pane's next line on its
        // last row scrolls them, as tmux scrolls the pane.
        await new Promise<void>(resolve => term.write('\r\nnext', resolve))
        expect(screen(term)).toEqual(['file', '$ ', 'next', '', '', ''])
        expect(allLines(term).slice(0, 12)).toEqual([...history, '$ ls', 'file', '$ ', 'next'])
    })

    it('pane shorter than the tab in the alternate screen: the program\'s exit restores the cursor on the shell\'s row', async () => {
        const history = Array.from({ length: 8 }, (_, i) => `old ${i + 1}`)
        const shortPane: TmuxPaneCapture = {
            text: [...history, '$ ls', '$ claude', ''].join('\n'),
            cursorX: 2,
            cursorY: 1,
            paneWidth: COLS,
            paneHeight: 3,
            windowHeight: ROWS,
            alternate: { text: ['CLAUDE-1', '> type here', 'status'].join('\n'), savedCursor: { x: 0, y: 2 } },
            modes: { cursorVisible: false, mouseMode: 1002, mouseEncoding: 1006 },
        }
        const running = await terminalAfter(renderCapture(shortPane))
        expect(screen(running)).toEqual(['CLAUDE-1', '> type here', 'status', '', '', ''])
        expect(running.buffer.active.cursorY).toBe(1)
        const term = await terminalAfter(renderCapture(shortPane), CLAUDE_EXIT)
        // The exit's new line on the pane's last row scrolls the pane's rows.
        expect(screen(term)).toEqual(['$ claude', 'Resume this session', '$ ', '', '', ''])
        expect(allLines(term).filter(l => l.startsWith('old'))).toEqual(history)
        expect(allLines(term)).toContain('$ ls')
    })

    it('a clear with no capture after it (the capture failed): normal screen, cursor shown, mouse off', async () => {
        const term = await terminalAfter(renderCapture(CLAUDE_RUNNING), CLEAR_SCREEN)
        expect(term.buffer.active.type).toBe('normal')
        expect(screen(term)).toEqual(['', '', '', '', '', ''])
        expect(cursorHidden(term)).toBe(false)
        expect(term.modes.mouseTrackingMode).toBe('none')
    })

    it('modes: cursor and every mouse mode reset, then the pane\'s mode and encoding set', () => {
        expect(renderModes(DEFAULT_MODES)).toBe('\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l')
        expect(renderModes({ cursorVisible: false, mouseMode: 1000, mouseEncoding: 1005 }))
            .toBe('\x1b[?25l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1000h\x1b[?1005h')
    })
})
