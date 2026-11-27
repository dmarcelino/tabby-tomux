// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'
import { TomuxConnection } from './tmux/connection'
import { TomuxPaneSession, WORKING_DIRECTORY_TIMEOUT_MS } from './paneSession'
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

const STATE = '#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{alternate_on}|#{alternate_saved_x}|#{alternate_saved_y}|#{history_size}|#{cursor_flag}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}'
/** Cursor 2,1 on an 80x24 pane, not in the alternate screen, cursor shown, mouse off. */
const NORMAL_STATE = '2|1|80|24|0|4294967295|4294967295|1|1|0|0|0|0|0'
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l'
const DEFAULT_MODES = '\x1b[?25h' + MOUSE_OFF
const CLEAR = '\x1b[?1049l\x1b[0m\x1b[2J\x1b[3J\x1b[H' + DEFAULT_MODES
/** The redraw's text is written in a scroll region of the pane's 24 rows, then the full region again. */
const PANE_REGION = '\x1b[1;24r'
const FULL_REGION = '\x1b[r'
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
        expect(text).toContain('$ prompt\x1b[0m' + FULL_REGION + '\x1b[2;3H')
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
        expect(session.emitted.join('')).toContain('next \x1b[4mlast\x1b[0m' + FULL_REGION + '\x1b[2;3H')
    })

    it('resets the text style after the snapshot of a newly active pane', async () => {
        const session = await sessionEndingStyled()
        await session.start()
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain('next \x1b[4mlast\x1b[0m' + FULL_REGION + '\x1b[2;3H')
    })

    it('starts a newly active pane\'s redraw from the default style, right after the marker', async () => {
        const session = await adoptedSession()
        await session.start()
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain(paneSwitchMarker('%0') + CLEAR + PANE_REGION + '\x1b[0mhistory line')
    })

    it('clears screen and scrollback before redrawing a reconnecting tab', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true, redraw: true })
        const text = session.emitted.join('')
        // Reset first: earlier output may have left a style on, and ESC[2J
        // paints with the current background (design decision 1b).
        expect(text.startsWith(CLEAR + PANE_REGION + '\x1b[0mhistory line')).toBe(true)
        expect(text).toContain('$ prompt\x1b[0m' + FULL_REGION + '\x1b[2;3H')
    })
    it('switches the tab to its normal screen before clearing it for a redraw, and only then', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        // A plain adopt draws on a new terminal: restoring a cursor nobody
        // saved would move it to the top-left corner.
        expect(session.emitted.join('')).not.toContain('\x1b[?1049l')
        session.switchPane('%0')
        await settle()
        expect(session.emitted.join('')).toContain(paneSwitchMarker('%0') + '\x1b[?1049l\x1b[0m\x1b[2J')
    })

    it('sets the pane\'s cursor visibility and mouse mode after every redraw', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toContain('$ prompt\x1b[0m' + FULL_REGION + '\x1b[2;3H' + DEFAULT_MODES)
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
            PANE_REGION + '\x1b[0mhistory line\r\n$ shell\x1b[0m' + FULL_REGION +
            // The cursor the program's ESC[?1049l will restore, then the switch.
            '\x1b[4;3H\x1b[?1049h' +
            // The switch leaves the cursor where it was: the program's screen starts at the top.
            '\x1b[H\x1b[0mALT\x1b[0m\x1b[2;5H' +
            '\x1b[?25l' + MOUSE_OFF + '\x1b[?1002h\x1b[?1006h',
        )
    })

    it('leaves the saved cursor alone when tmux saved none', async () => {
        const { session } = await twoPanes('4294967295|4294967295')
        await session.start({ adopt: true })
        expect(session.emitted.join('')).toContain('$ shell\x1b[0m' + FULL_REGION + '\x1b[?1049h\x1b[H\x1b[0mALT')
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
        expect(text).toBe(paneSwitchMarker('%2') + CLEAR + PANE_REGION + '\x1b[0mother pane\x1b[0m' + FULL_REGION + '\x1b[2;3H' + DEFAULT_MODES + 'newer')
    })
})
