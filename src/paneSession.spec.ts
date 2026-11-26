// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'
import { TomuxConnection } from './tmux/connection'
import { TomuxPaneSession, WORKING_DIRECTORY_TIMEOUT_MS } from './paneSession'
import { paneSwitchMarker } from './tabTitle'

// tabby-terminal needs Tabby's Angular runtime; a minimal BaseSession is enough
// here. vi.mock is hoisted above the imports. As in Tabby, emitOutput is the
// path through the session middleware (where plugins such as tabby-trzsz
// listen), and output / binaryOutput are what the tab shows after it.
vi.mock('tabby-terminal', () => ({
    BaseSession: class {
        open = false
        constructor (protected logger: unknown) {}
        /** Everything shown in the tab, in order, whichever path it took. */
        readonly emitted: string[] = []
        /** What went through the session middleware. */
        readonly viaMiddleware: string[] = []
        /** What was shown directly, past the middleware. */
        readonly direct: string[] = []
        readonly directBinary: string[] = []
        protected output = { next: (text: string): void => { this.emitted.push(text); this.direct.push(text) } }
        protected binaryOutput = { next: (data: Buffer): void => { this.directBinary.push(data.toString('utf-8')) } }
        emitOutput (data: Buffer): void {
            const text = data.toString('utf-8')
            this.emitted.push(text)
            this.viaMiddleware.push(text)
        }
        async destroy (): Promise<void> { /* nothing to release */ }
    },
}))

interface RecordedOutput {
    emitted: string[]
    viaMiddleware: string[]
    direct: string[]
    directBinary: string[]
}

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
    const CURSOR = 'display-message -p -t %0 "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"'

    async function adoptedSession (): Promise<InstanceType<typeof TomuxPaneSession> & { emitted: string[] }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, ['history line', '$ prompt'])
        tmux.overrides.set(CURSOR, ['2 1 80 24'])
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
        tmux.overrides.set(CURSOR, ['2 1 80 24'])
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
        expect(session.emitted.join('')).toContain(paneSwitchMarker('%0') + '\x1b[0m\x1b[2J\x1b[3J\x1b[H\x1b[0mhistory line')
    })

    it('clears screen and scrollback before redrawing a reconnecting tab', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true, redraw: true })
        const text = session.emitted.join('')
        // Reset first: earlier output may have left a style on, and ESC[2J
        // paints with the current background (design decision 1b).
        expect(text.startsWith('\x1b[0m\x1b[2J\x1b[3J\x1b[H\x1b[0mhistory line')).toBe(true)
        expect(text).toContain('$ prompt\x1b[0m\x1b[2;3H')
    })
})

// History drawn again from tmux is not new output: it must reach the tab
// without passing through the session middleware, or tabby-trzsz would see
// the start line of a finished transfer and start a transfer that does not
// exist. Output the pane produces afterwards still goes through it.
describe('TomuxPaneSession replays bypass the session middleware', () => {
    const CAPTURE = 'capture-pane -p -e -J -S - -t %0'
    const CURSOR = 'display-message -p -t %0 "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"'
    const TRZSZ_LINE = '::TRZSZ:TRANSFER:S:1.1.8:1732600000000:0'

    async function setup (captureReply: string[] | 'silent' = ['$ tsz file', TRZSZ_LINE, '$ ']): Promise<{ tmux: FakeTmux, session: InstanceType<typeof TomuxPaneSession> & RecordedOutput }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, captureReply)
        tmux.overrides.set(CURSOR, captureReply === 'silent' ? 'silent' : ['2 2 80 24'])
        const conn = await TomuxConnection.open(tmux, 'main')
        const session = new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as any
        return { tmux, session }
    }

    it('shows an adopted snapshot directly and never through the middleware', async () => {
        const { session } = await setup()
        await session.start({ adopt: true })
        expect(session.direct.join('')).toContain(TRZSZ_LINE)
        expect(session.directBinary).toEqual(session.direct)
        expect(session.viaMiddleware.join('')).not.toContain('TRZSZ')
    })

    it('shows a reconnect redraw, clear included, directly', async () => {
        const { session } = await setup()
        await session.start({ adopt: true, redraw: true })
        expect(session.direct.join('').startsWith('\x1b[0m\x1b[2J\x1b[3J\x1b[H')).toBe(true)
        expect(session.direct.join('')).toContain(TRZSZ_LINE)
        expect(session.viaMiddleware).toEqual([])
    })

    it('shows a pane-switch redraw (marker, clear and capture) directly', async () => {
        const { session } = await setup()
        await session.start()
        session.switchPane('%0')
        await settle()
        expect(session.direct.join('')).toContain(paneSwitchMarker('%0') + '\x1b[0m\x1b[2J\x1b[3J\x1b[H')
        expect(session.direct.join('')).toContain(TRZSZ_LINE)
        expect(session.viaMiddleware.join('')).not.toContain('TRZSZ')
    })

    it('sends output newer than the capture, and later output, through the middleware after the replay', async () => {
        const { tmux, session } = await setup('silent')
        const started = session.start({ adopt: true })
        await settle()
        tmux.channel.send('%output %0 old\r\n')          // before the capture: inside it, dropped
        tmux.channel.reply(['$ tsz file', TRZSZ_LINE])       // capture-pane
        tmux.channel.send('%output %0 newer\r\n')        // after the capture started
        tmux.channel.reply(['2 1 80 24'])                    // cursor
        await started
        tmux.channel.send('%output %0 later\r\n')
        await settle()
        expect(session.viaMiddleware).toEqual(['newer', 'later'])
        expect(session.emitted.map(text => text.includes(TRZSZ_LINE) ? 'REPLAY' : text))
            .toEqual(['REPLAY', 'newer', 'later'])
    })
})
