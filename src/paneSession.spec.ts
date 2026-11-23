// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'
import { TomuxConnection } from './tmux/connection'
import { TomuxPaneSession, WORKING_DIRECTORY_TIMEOUT_MS } from './paneSession'

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
    const CURSOR = 'display-message -p -t %0 "#{cursor_x} #{cursor_y}"'

    async function adoptedSession (): Promise<InstanceType<typeof TomuxPaneSession> & { emitted: string[] }> {
        const tmux = new FakeTmux()
        tmux.overrides.set(CAPTURE, ['history line', '$ prompt'])
        tmux.overrides.set(CURSOR, ['2 1'])
        const conn = await TomuxConnection.open(tmux, 'main')
        return new TomuxPaneSession(logger as any, conn, '%0', () => undefined) as any
    }

    it('shows an adopted window\'s history without clearing the screen', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true })
        const text = session.emitted.join('')
        expect(text).toContain('history line')
        expect(text.startsWith('\x1b[2J')).toBe(false)
    })

    it('clears screen and scrollback before redrawing a reconnecting tab', async () => {
        const session = await adoptedSession()
        await session.start({ adopt: true, redraw: true })
        const text = session.emitted.join('')
        expect(text.startsWith('\x1b[2J\x1b[3J\x1b[H')).toBe(true)
        expect(text).toContain('history line')
    })
})
