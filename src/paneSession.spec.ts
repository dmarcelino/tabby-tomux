// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'
import { TomuxConnection } from './tmux/connection'
import { BORDER_STATUS_TIMEOUT_MS, TomuxPaneSession, WORKING_DIRECTORY_TIMEOUT_MS } from './paneSession'
import { paneSwitchMarker } from './tabTitle'

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

const STATE = '#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{alternate_on}|#{alternate_saved_x}|#{alternate_saved_y}|#{history_size}|#{cursor_flag}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}|#{window_height}'
/** Cursor 2,1 on an 80x24 pane, not in the alternate screen, cursor shown, mouse off. */
const NORMAL_STATE = '2|1|80|24|0|4294967295|4294967295|1|1|0|0|0|0|0'
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l'
const DEFAULT_MODES = '\x1b[?25h' + MOUSE_OFF
/**
 * The pane rows keeper sets the pane's 24-row region, keeping the cursor
 * where it is: when the capture's height is applied, and after every screen
 * switch.
 */
const KEEP_REGION = '\x1b7\x1b[1;24r\x1b8'
const CLEAR = '\x1b[?1049l' + KEEP_REGION + '\x1b[0m\x1b[2J\x1b[3J\x1b[H' + DEFAULT_MODES
/** The redraw's text is written in a scroll region of the pane's 24 rows, and the region stays. */
const PANE_REGION = '\x1b[1;24r'
const CWD_COMMAND = 'display-message -p -t %0 "#{pane_current_path}"'
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }

async function makeSession (cwdReply?: string[] | { error: string } | 'silent'): Promise<{ tmux: FakeTmux, conn: TomuxConnection, session: InstanceType<typeof TomuxPaneSession> }> {
    const tmux = new FakeTmux()
    if (cwdReply) {
        tmux.overrides.set(CWD_COMMAND, cwdReply)
    }
    const conn = await TomuxConnection.open(tmux, 'main')
    const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined)
    return { tmux, conn, session }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('TomuxPaneSession working directory', () => {
    it('supports it while the connection is live and reads the pane\'s path from tmux', async () => {
        const { tmux, session } = await makeSession(['/srv/app'])
        expect(session.supportsWorkingDirectory()).toBe(true)
        await expect(session.getWorkingDirectory()).resolves.toBe('/srv/app')
        expect(tmux.channel.commands).toContain(CWD_COMMAND)
    })

    it('returns null when tmux reports no path', async () => {
        const { session } = await makeSession([''])
        await expect(session.getWorkingDirectory()).resolves.toBeNull()
    })

    it('returns null when the tmux command fails', async () => {
        const { session } = await makeSession({ error: "can't find pane: %0" })
        await expect(session.getWorkingDirectory()).resolves.toBeNull()
    })

    it('stops supporting it and returns null without asking tmux once the connection ended', async () => {
        const { tmux, conn, session } = await makeSession(['/srv/app'])
        tmux.channel.remoteClose()
        await settle()
        expect(conn.isLive).toBe(false)
        expect(session.supportsWorkingDirectory()).toBe(false)
        const before = tmux.channel.commands.length
        await expect(session.getWorkingDirectory()).resolves.toBeNull()
        expect(tmux.channel.commands.length).toBe(before)
    })

    it('returns null when tmux does not answer in time', async () => {
        const { session } = await makeSession('silent')
        vi.useFakeTimers()
        const result = session.getWorkingDirectory()
        await vi.advanceTimersByTimeAsync(WORKING_DIRECTORY_TIMEOUT_MS)
        await expect(result).resolves.toBeNull()
    })
})

describe('TomuxPaneSession start', () => {
    const CAPTURE = 'capture-pane -p -e -J -S - -t %0'
    const CURSOR = `display-message -p -t %0 "${STATE}"`

    async function adoptedSession (): Promise<InstanceType<typeof TomuxPaneSession> & { emitted: string[] }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, ['history line', '$ prompt'])
        tmux.overrides.set(CURSOR, [NORMAL_STATE])
        const conn = await TomuxConnection.open(tmux, 'main')
        return new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as any
    }

    it('shows an adopted window\'s history without clearing the screen', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        const text = session.emitted.join('')
        expect(text).toContain('history line\r\n$ prompt')
        expect(text).toContain('$ prompt\x1b[0m\x1b[2;3H')
        expect(text.startsWith('\x1b[2J')).toBe(false)
    })

    // tmux's capture-pane -e never ends with a reset: when the last captured
    // cell is styled, the style stays on after the snapshot and would carry
    // over to the program's next redraw.
    async function sessionEndingStyled (): Promise<InstanceType<typeof TomuxPaneSession> & { emitted: string[] }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, ['history line', 'next \x1b[4mlast'])
        tmux.overrides.set(CURSOR, [NORMAL_STATE])
        const conn = await TomuxConnection.open(tmux, 'main')
        return new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as any
    }

    it('resets the text style after an adopted snapshot, before moving the cursor', async () => {
        const session = await sessionEndingStyled()
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toContain('next \x1b[4mlast\x1b[0m\x1b[2;3H')
    })

    it('resets the text style after the snapshot of a newly active pane', async () => {
        const session = await sessionEndingStyled()
        await session.start()
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain('next \x1b[4mlast\x1b[0m\x1b[2;3H')
    })

    it('starts a newly active pane\'s redraw from the default style, right after the marker', async () => {
        const session = await adoptedSession()
        await session.start()
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain(KEEP_REGION + paneSwitchMarker('%0') + CLEAR + PANE_REGION + '\x1b[0mhistory line')
    })

    it('clears screen and scrollback before redrawing a reconnecting tab', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true, redraw: true })
        const text = session.emitted.join('')
        // Reset first: earlier output may have left a style on, and ESC[2J
        // paints with the current background (design decision 1b).
        expect(text.startsWith(KEEP_REGION + CLEAR + PANE_REGION + '\x1b[0mhistory line')).toBe(true)
        expect(text).toContain('$ prompt\x1b[0m\x1b[2;3H')
    })
    it('switches the tab to its normal screen before clearing it for a redraw, and only then', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        // A plain adopt draws on a new terminal: restoring a cursor nobody
        // saved would move it to the top-left corner.
        expect(session.emitted.join('')).not.toContain('\x1b[?1049l')
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain(paneSwitchMarker('%0') + '\x1b[?1049l' + KEEP_REGION + '\x1b[0m\x1b[2J')
    })

    it('sets the pane\'s cursor visibility and mouse mode after every redraw', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toContain('$ prompt\x1b[0m\x1b[2;3H' + DEFAULT_MODES)
    })
})

describe('TomuxPaneSession alternate screen', () => {
    const SECOND = (pane: string): string[] => [
        `capture-pane -p -e -J -a -t ${pane}`,
        `capture-pane -p -e -J -S - -E -1 -t ${pane}`,
        `capture-pane -p -e -J -t ${pane}`,
    ]

    /** Pane %1 runs a full-screen program; pane %2 is a shell. */
    async function twoPanes (savedCursor = '2|3'): Promise<{ tmux: FakeTmux, session: InstanceType<typeof TomuxPaneSession> & { emitted: string[] } }> {
        const tmux = new FakeTmux()
        const altState = `4|1|80|24|1|${savedCursor}|1|0|0|1|0|1|0`
        tmux.overrides.set('capture-pane -p -e -J -S - -t %1', ['history line', 'ALT old'])
        tmux.overrides.set(`display-message -p -t %1 "${STATE}"`, [altState])
        const [saved, history, screen] = SECOND('%1')
        tmux.overrides.set(saved, ['$ shell'])
        tmux.overrides.set(history, ['history line'])
        tmux.overrides.set(screen, ['ALT'])
        tmux.overrides.set('capture-pane -p -e -J -S - -t %2', ['other pane'])
        tmux.overrides.set(`display-message -p -t %2 "${STATE}"`, [NORMAL_STATE])
        const conn = await TomuxConnection.open(tmux, 'main')
        const session = new TomuxPaneSession(logger as any, conn, '%1', () => undefined) as any
        return { tmux, session }
    }

    it('draws the shell\'s screen, then the program\'s screen on the alternate screen', async () => {
        const { session } = await twoPanes()
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toBe(
            KEEP_REGION + PANE_REGION + '\x1b[0mhistory line\r\n$ shell\x1b[0m' +
            // The cursor the program's ESC[?1049l will restore, then the switch.
            '\x1b[4;3H\x1b[?1049h' + KEEP_REGION +
            // The switch leaves the cursor where it was: the program's screen
            // starts at the top (DECSTBM homes it), in the pane's rows.
            PANE_REGION + '\x1b[0mALT\x1b[0m\x1b[2;5H' +
            '\x1b[?25l' + MOUSE_OFF + '\x1b[?1002h\x1b[?1006h',
        )
    })

    it('leaves the saved cursor alone when tmux saved none', async () => {
        const { session } = await twoPanes('4294967295|4294967295')
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toContain('$ shell\x1b[0m\x1b[?1049h' + KEEP_REGION + PANE_REGION + '\x1b[0mALT')
    })

    it('draws only the last pane when the active pane changes again before a capture arrives', async () => {
        const { tmux, session } = await twoPanes()
        await session.start()
        const channel = tmux.channel
        const write = channel.write.bind(channel)
        // Pane %2 prints right after its capture, before tmux answers the
        // second line of pane %1's (slower) capture.
        channel.write = async (data: Uint8Array): Promise<void> => {
            if (Buffer.from(data).toString('utf8').includes('-a -t %1')) {
                channel.send('%output %2 newer\r\n')
            }
            return write(data)
        }
        session.switchPane('%1')
        session.switchPane('%2')
        await settle()
        const text = session.emitted.join('')
        expect(text).toBe(KEEP_REGION + paneSwitchMarker('%2') + CLEAR + PANE_REGION + '\x1b[0mother pane\x1b[0m\x1b[2;3H' + DEFAULT_MODES + 'newer')
    })
})

describe('TomuxPaneSession pane height', () => {
    const CAPTURE = 'capture-pane -p -e -J -S - -t %0'
    const CURSOR = `display-message -p -t %0 "${STATE}"`
    /** Cursor 2,1 on pane %0 of `pane` rows, in a window of `window` rows. */
    const state = (pane: number, window: number): string => `2|1|97|${pane}|0|4294967295|4294967295|1|1|0|0|0|0|0|${window}`
    /** Pane %0 (12 rows) above pane %1 (12 rows), in window @0. */
    const STACKED = '928d,97x25,0,0[97x12,0,0,0,97x12,0,13,1]'
    const ONE_PANE = 'ba1d,97x25,0,0,0'
    const region = (height: number): string => `\x1b7\x1b[1;${height}r\x1b8`
    /** What a redraw of the captured `$ prompt` writes for a pane of `height` rows, after a clear. */
    const redraw = (height: number): string =>
        '\x1b[?1049l' + region(height) + '\x1b[0m\x1b[2J\x1b[3J\x1b[H' + DEFAULT_MODES +
        `\x1b[1;${height}r\x1b[0m$ prompt\x1b[0m\x1b[2;3H` + DEFAULT_MODES
    const layoutChange = (window: string, layout: string, visible = layout): string =>
        `%layout-change ${window} ${layout} ${visible} *\r\n`

    type Session = InstanceType<typeof TomuxPaneSession> & { emitted: string[] }

    const BORDER = 'display-message -p -t %0 "#{pane-border-status}"'

    /** An adopted session of pane %0, captured at `pane` rows in a window of `window` rows. */
    async function adopted (pane: number, window: number, borderStatus = 'off'): Promise<{ tmux: FakeTmux, session: Session, captures: () => number }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(BORDER, [borderStatus])
        tmux.overrides.set(CAPTURE, ['$ prompt'])
        tmux.overrides.set(CURSOR, [state(pane, window)])
        const conn = await TomuxConnection.open(tmux, 'main')
        const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as Session
        await session.start({ adopt: true })
        session.emitted.length = 0
        const captures = (): number => tmux.channel.commands.filter(c => c === CAPTURE).length
        return { tmux, session, captures }
    }

    it('sets the region for a pane as tall as its window, without drawing it again', async () => {
        const { tmux, session, captures } = await adopted(25, 25)
        tmux.channel.send(layoutChange('@0', 'ba1d,97x30,0,0,0'))
        await settle()
        expect(session.emitted.join('')).toBe(region(30))
        expect(captures()).toBe(1)
    })

    it('draws the pane again when it becomes shorter than its window', async () => {
        const { tmux, session, captures } = await adopted(25, 25)
        tmux.overrides.set(CURSOR, [state(12, 25)])
        tmux.channel.send(layoutChange('@0', STACKED))
        await settle()
        expect(captures()).toBe(2)
        expect(session.emitted.join('')).toBe(region(12) + redraw(12))
        // The same rows again change nothing.
        tmux.channel.send(layoutChange('@0', STACKED))
        await settle()
        expect(captures()).toBe(2)
    })

    it('draws a shorter pane again when it is zoomed and unzoomed', async () => {
        const { tmux, session, captures } = await adopted(12, 25)
        tmux.overrides.set(CURSOR, [state(25, 25)])
        tmux.channel.send(layoutChange('@0', STACKED, ONE_PANE))
        await settle()
        expect(session.emitted.join('')).toBe(region(25) + redraw(25))
        tmux.overrides.set(CURSOR, [state(12, 25)])
        tmux.channel.send(layoutChange('@0', STACKED))
        await settle()
        expect(session.emitted.join('')).toBe(region(25) + redraw(25) + region(12) + redraw(12))
        expect(captures()).toBe(3)
    })

    it('ignores a layout change of another window, or one where another pane is zoomed', async () => {
        const { tmux, session, captures } = await adopted(12, 25)
        tmux.channel.send(layoutChange('@1', 'abcd,97x25,0,0[97x12,0,0,3,97x12,0,13,4]'))
        tmux.channel.send(layoutChange('@0', STACKED, 'b25d,97x25,0,0,1'))
        await settle()
        expect(session.emitted).toEqual([])
        expect(captures()).toBe(1)
    })

    it('limits the pane\'s own scroll regions to its height', async () => {
        const { tmux, session } = await adopted(12, 25)
        tmux.channel.send('%output %0 \\033[r$ \r\n')
        await settle()
        expect(session.emitted.join('')).toBe('\x1b[1;12r$ ')
    })

    it('stops following layout changes once destroyed', async () => {
        const { tmux, session, captures } = await adopted(25, 25)
        await session.destroy()
        tmux.channel.send(layoutChange('@0', STACKED))
        await settle()
        expect(session.emitted).toEqual([])
        expect(captures()).toBe(1)
    })

    /** An adopted session whose capture is still waiting for its cursor reply. */
    async function captureInProgress (): Promise<{ tmux: FakeTmux, session: Session, started: Promise<void> }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, ['$ prompt'])
        tmux.overrides.set(CURSOR, 'silent')
        const conn = await TomuxConnection.open(tmux, 'main')
        const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as Session
        const started = session.start({ adopt: true })
        await settle()
        return { tmux, session, started }
    }

    it('shows output and a layout change that came during a capture after the snapshot, in order', async () => {
        const { tmux, session, started } = await captureInProgress()
        tmux.channel.send('%output %0 a\r\n' + layoutChange('@0', STACKED) + '%output %0 b\r\n')
        await settle()
        expect(session.emitted).toEqual([])
        tmux.overrides.set(CURSOR, [state(12, 25)])
        tmux.channel.reply([state(25, 25)])
        await started
        await settle()
        expect(session.emitted.join('')).toBe(
            // The capture at 25 rows first.
            region(25) + '\x1b[1;25r\x1b[0m$ prompt\x1b[0m\x1b[2;3H' + DEFAULT_MODES +
            // Then the output after it, and the pane at its new height, drawn
            // again: 'b' came before the new capture, so it is in it.
            'a' + region(12) + redraw(12),
        )
    })

    it('sets the region again after a resize, after the snapshot when it came during a capture', async () => {
        const { tmux, session, started } = await captureInProgress()
        session.resize(97, 30)
        tmux.channel.reply([NORMAL_STATE])
        await started
        expect(session.emitted.join('').endsWith('\x1b[2;3H' + DEFAULT_MODES + region(24))).toBe(true)
        session.resize(97, 31)
        expect(session.emitted[session.emitted.length - 1]).toBe(region(24))
    })

    describe('with the pane border status line at the top', () => {
        it('counts the status line out of the pane\'s rows, so a lone pane is not drawn again', async () => {
            // tmux: a lone pane of a 25-row window is 24 rows with the status line on top.
            const { tmux, session, captures } = await adopted(24, 25, 'top')
            tmux.channel.send(layoutChange('@0', ONE_PANE))
            await settle()
            expect(session.emitted).toEqual([])
            expect(captures()).toBe(1)
            // Split: the top pane's 12-row cell holds the status line and 11 rows.
            tmux.overrides.set(CURSOR, [state(11, 25)])
            tmux.channel.send(layoutChange('@0', STACKED))
            await settle()
            expect(session.emitted.join('')).toBe(region(11) + redraw(11))
        })

        it('a new tab reads it before showing layout changes held meanwhile', async () => {
            const tmux = new FakeTmux()
            tmux.overrides.set(BORDER, 'silent')
            const conn = await TomuxConnection.open(tmux, 'main')
            const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as Session
            const started = session.start()
            await settle()
            tmux.channel.send(layoutChange('@0', ONE_PANE))
            await settle()
            expect(session.emitted).toEqual([])
            tmux.overrides.set(CURSOR, [state(24, 25)])
            tmux.channel.reply(['top'])
            await started
            await settle()
            // 24 rows, not the cell's 25; with no rows known before, a shorter pane is drawn.
            expect(session.emitted.join('').startsWith(region(24))).toBe(true)
            expect(tmux.channel.commands.filter(c => c === CAPTURE)).toHaveLength(1)
        })

        it('a new tab shows its output when tmux does not answer in time, as without a status line', async () => {
            const tmux = new FakeTmux()
            tmux.overrides.set(BORDER, 'silent')
            const conn = await TomuxConnection.open(tmux, 'main')
            const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as Session
            tmux.channel.send('%output %0 $ \r\n')
            vi.useFakeTimers()
            const started = session.start()
            await vi.advanceTimersByTimeAsync(BORDER_STATUS_TIMEOUT_MS)
            await started
            expect(session.emitted.join('')).toBe('$ ')
        })
    })

    it('forgets the pane\'s rows when the capture of a newly active pane fails', async () => {
        const { tmux, session } = await adopted(12, 25)
        tmux.overrides.set('capture-pane -p -e -J -S - -t %1', { error: "can't find pane: %1" })
        session.switchPane('%1')
        await settle()
        // The whole tab is the region again, then the clear.
        expect(session.emitted.join('')).toBe('\x1b7\x1b[r\x1b8' + paneSwitchMarker('%1') + CLEAR.replace(KEEP_REGION, ''))
        session.emitted.length = 0
        // The new pane's output is not limited to the old pane's rows.
        tmux.channel.send('%output %1 \\033[r\r\n')
        await settle()
        expect(session.emitted.join('')).toBe('\x1b[r')
        // Its rows are unknown: a shorter pane in the next layout change is drawn.
        tmux.channel.send(layoutChange('@0', STACKED))
        await settle()
        expect(tmux.channel.commands.filter(c => c === 'capture-pane -p -e -J -S - -t %1')).toHaveLength(2)
    })

    it('drops an unfinished escape sequence of earlier output when the pane is drawn again', async () => {
        const { tmux, session } = await adopted(12, 25)
        tmux.channel.send('%output %0 a\\033[1;\r\n')
        await settle()
        expect(session.emitted.join('')).toBe('a')
        session.switchPane('%0')
        await settle()
        const text = session.emitted.join('')
        expect(text).toBe('a' + paneSwitchMarker('%0') + text.slice(1 + paneSwitchMarker('%0').length))
        expect(text).not.toContain('\x1b[1;\x1b')
    })
})
