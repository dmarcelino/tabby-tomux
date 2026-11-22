// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectCreatedSession, TmuxVersionError, TomuxConnection, TomuxConnectionEvent } from './connection'
import { FakeTmux, settle } from './fakeTmux.testing'

const KILL = /^kill-/u

async function openFake (opts: ConstructorParameters<typeof FakeTmux>[0] = {}): Promise<{ tmux: FakeTmux, conn: TomuxConnection }> {
    const tmux = new FakeTmux(opts)
    const conn = await TomuxConnection.open(tmux, 'main')
    return { tmux, conn }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('TomuxConnection.open', () => {
    it('rejects an old tmux naming both versions, releases, and opens no channel', async () => {
        const tmux = new FakeTmux({ version: 'tmux 1.8\n' })
        const error = await TomuxConnection.open(tmux, 'main').catch(e => e)
        expect(error).toBeInstanceOf(TmuxVersionError)
        expect(error.message).toContain('tmux 1.8')
        expect(error.message).toContain('2.1')
        expect(tmux.holds).toBe(1)
        expect(tmux.releases).toBe(1)
        expect(tmux.channels).toHaveLength(0)
    })

    it('rejects when tmux is not installed', async () => {
        const tmux = new FakeTmux({ version: 'bash: tmux: command not found' })
        await expect(TomuxConnection.open(tmux, 'main')).rejects.toThrow(/needs tmux 2\.1 or newer.*no tmux/u)
        expect(tmux.releases).toBe(1)
        expect(tmux.channels).toHaveLength(0)
    })

    it('rejects when tmux -V fails', async () => {
        const tmux = new FakeTmux({ versionError: new Error('SendError') })
        await expect(TomuxConnection.open(tmux, 'main')).rejects.toThrow(/2\.1.*SendError/u)
        expect(tmux.releases).toBe(1)
    })

    it('accepts tmux 2.1 and development builds without a number', async () => {
        await expect(openFake({ version: 'tmux 2.1' })).resolves.toBeDefined()
        await expect(openFake({ version: 'tmux master' })).resolves.toBeDefined()
    })

    it('attaches to an existing session and lists its windows', async () => {
        const { tmux, conn } = await openFake({
            windows: ['@0|0|%0|0|1|bash', '@3|1|%5|1|0|logs'],
            sessionCreated: 1700000000,
            clientCreated: 1700005000,
        })
        expect(tmux.openedSessions).toEqual(['main'])
        expect(tmux.holds).toBe(1)
        expect(tmux.releases).toBe(0)
        expect(conn.sessionName).toBe('main')
        expect(conn.tmuxVersion).toBe('tmux 3.5a')
        expect(conn.client.versionAtLeast(3, 5)).toBe(true)
        expect(conn.createdSession).toBe(false)
        expect(conn.initialWindows.map(w => w.id)).toEqual(['@0', '@3'])
        expect(conn.initialWindows[1]).toMatchObject({ name: 'logs', paneId: '%5', active: true, automaticRename: false })
        expect(conn.state).toBe('open')
        expect(conn.isLive).toBe(true)
        // Readiness probe, created check and window list; no resize on open.
        expect(tmux.channel.commands).toEqual([
            'display-message -p "__tomux_ready__"',
            'display-message -p "#{session_created} #{client_created}"',
            expect.stringMatching(/^list-windows -F /u),
        ])
        expect(tmux.channel.commands.some(c => c.startsWith('refresh-client'))).toBe(false)
    })

    it('reports a session it just created', async () => {
        const { conn } = await openFake({ sessionCreated: 1700000100, clientCreated: 1700000100 })
        expect(conn.createdSession).toBe(true)
        expect(conn.initialWindows).toHaveLength(1)
    })

    it('encodes writes as UTF-8', async () => {
        const { tmux, conn } = await openFake()
        void conn.client.sendCommand("rename-window -t @0 'café ✓'")
        await settle()
        expect(tmux.channel.writes).toContain("rename-window -t @0 'café ✓'\r")
    })

    it('fails and cleans up when the channel closes during the handshake', async () => {
        const tmux = new FakeTmux()
        tmux.startup = channel => { channel.remoteClose() }
        await expect(TomuxConnection.open(tmux, 'main')).rejects.toThrow(/ended while connecting \(lost\)/u)
        expect(tmux.releases).toBe(1)
    })

    it('times out when control mode never answers', async () => {
        vi.useFakeTimers()
        const tmux = new FakeTmux()
        tmux.startup = () => undefined
        const opening = TomuxConnection.open(tmux, 'main', { readyTimeoutMs: 1000 }).catch(e => e)
        await vi.advanceTimersByTimeAsync(1000)
        expect((await opening).message).toMatch(/Timed out/u)
        expect(tmux.releases).toBe(1)
        expect(tmux.channel.closeCalls).toBe(1)
    })
})

describe('TomuxConnection terminal states', () => {
    it('%exit → exited, with the reason; releases once and closes the channel', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.exit('detached')
        await expect(conn.closed).resolves.toBe('exited')
        expect(conn.state).toBe('exited')
        expect(conn.exitReason).toBe('detached')
        expect(tmux.releases).toBe(1)
    })

    it('channel closed without %exit → lost', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.remoteClose()
        await expect(conn.closed).resolves.toBe('lost')
        expect(tmux.releases).toBe(1)
    })

    it('EOF without %exit → lost', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.eof$.next()
        await expect(conn.closed).resolves.toBe('lost')
        expect(tmux.channel.closeCalls).toBe(1)
    })

    it('sessionLost$ → lost', async () => {
        const { tmux, conn } = await openFake()
        tmux.sessionLost$.next()
        await expect(conn.closed).resolves.toBe('lost')
        expect(tmux.releases).toBe(1)
        expect(tmux.channel.closeCalls).toBe(1)
    })

    it('a failed write → lost', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.isClosed = true
        void conn.client.sendCommand('list-windows').catch(() => undefined)
        await expect(conn.closed).resolves.toBe('lost')
    })

    it('only the first terminal event counts', async () => {
        const { tmux, conn } = await openFake()
        const states: string[] = []
        conn.closed$.subscribe(s => states.push(s))
        tmux.channel.exit()
        tmux.sessionLost$.next()
        await settle()
        expect(states).toEqual(['exited'])
        expect(tmux.releases).toBe(1)
    })

    it('rejects pending commands when the connection ends', async () => {
        const { tmux, conn } = await openFake()
        tmux.overrides.set('list-windows', 'silent')
        const pending = conn.client.sendCommand('list-windows')
        await settle()
        tmux.channel.remoteClose()
        await expect(pending).rejects.toThrow('tmux process exited')
    })

    it('ping answers true while live and false after the end', async () => {
        const { tmux, conn } = await openFake()
        await expect(conn.ping()).resolves.toBe(true)
        tmux.channel.remoteClose()
        await expect(conn.ping()).resolves.toBe(false)
    })

    it('ping resolves false on timeout', async () => {
        vi.useFakeTimers()
        const { conn } = await openFake({ ping: 'silent' })
        const ping = conn.ping(5000)
        await vi.advanceTimersByTimeAsync(5000)
        await expect(ping).resolves.toBe(false)
    })
})

describe('TomuxConnection after the end', () => {
    async function outcome (p: Promise<unknown>): Promise<string> {
        let result = 'pending'
        p.then(() => { result = 'resolved' }, (e: Error) => { result = `rejected: ${e.message}` })
        await settle()
        return result
    }

    it.each([
        ['exited', (tmux: FakeTmux) => tmux.channel.exit()],
        ['lost', (tmux: FakeTmux) => tmux.channel.remoteClose()],
        ['lost (session)', (tmux: FakeTmux) => tmux.sessionLost$.next()],
    ])('a command sent after the connection ended (%s) rejects at once', async (_label, end) => {
        const { tmux, conn } = await openFake()
        end(tmux)
        await conn.closed
        const writes = tmux.channel.writes.length
        expect(await outcome(conn.client.sendCommand('list-windows'))).toBe('rejected: tmux connection has ended')
        expect(await outcome(conn.client.sendCommandList(['a', 'b']))).toBe('rejected: tmux connection has ended')
        expect(tmux.channel.writes).toHaveLength(writes)
    })

    it('a command sent after detach rejects at once', async () => {
        const { conn } = await openFake()
        await conn.detach()
        expect(await outcome(conn.client.sendCommand('list-windows'))).toBe('rejected: tmux connection has ended')
    })

    it('a command whose write fails does not hang', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.isClosed = true
        const pending = conn.client.sendCommand('list-windows')
        expect(await outcome(pending)).toBe('rejected: tmux process exited')
        expect(conn.state).toBe('lost')
    })
})

describe('TomuxConnection session switch', () => {
    it('ends as exited with reason session-switched when tmux moves the client to another session', async () => {
        const { tmux, conn } = await openFake()
        const pending = conn.client.sendCommand('x').catch((e: Error) => e.message)
        tmux.overrides.set('x', 'silent')
        tmux.channel.send('%session-changed $4 other\r\n')
        await expect(conn.closed).resolves.toBe('exited')
        expect(conn.exitReason).toBe('session-switched')
        expect(tmux.channel.isClosed).toBe(true)
        expect(tmux.channel.commands).not.toContain('detach-client')
        expect(tmux.releases).toBe(1)
        await expect(pending).resolves.toBe('tmux process exited')
    })

    it('ignores %session-changed for the same session', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.send('%session-changed $0 main\r\n%session-changed $0 renamed\r\n')
        await settle()
        expect(conn.state).toBe('open')
        expect(conn.exitReason).toBeUndefined()
    })
})

describe('TomuxConnection ping liveness', () => {
    it('stays alive while data keeps arriving, then resolves true on the reply', async () => {
        vi.useFakeTimers()
        const { tmux, conn } = await openFake({ ping: 'silent' })
        let result: boolean | undefined
        void conn.ping(5000).then(r => { result = r })
        // A backlog: output streams in for 20 s before the reply comes.
        for (let i = 0; i < 20; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            tmux.channel.send('%output %0 busy\\015\\012\r\n')
        }
        expect(result).toBeUndefined()
        tmux.channel.reply(['__ping__'])
        await settle()
        expect(result).toBe(true)
    })

    it('fails timeoutMs after the data stops', async () => {
        vi.useFakeTimers()
        const { tmux, conn } = await openFake({ ping: 'silent' })
        let result: boolean | undefined
        void conn.ping(5000).then(r => { result = r })
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            tmux.channel.send('%output %0 x\r\n')
        }
        // Last data at t=10 s: still alive just before t=15 s.
        await vi.advanceTimersByTimeAsync(4999)
        expect(result).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(result).toBe(false)
    })

    it('fails after exactly timeoutMs on a silent channel', async () => {
        vi.useFakeTimers()
        const { conn } = await openFake({ ping: 'silent' })
        let result: boolean | undefined
        void conn.ping(5000).then(r => { result = r })
        await vi.advanceTimersByTimeAsync(4999)
        expect(result).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(result).toBe(false)
    })

    it('gives up at the absolute cap even while data keeps arriving', async () => {
        vi.useFakeTimers()
        const { tmux, conn } = await openFake({ ping: 'silent' })
        let result: boolean | undefined
        void conn.ping(5000).then(r => { result = r })
        for (let i = 0; i < 59; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            tmux.channel.send('%output %0 x\r\n')
        }
        expect(result).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1000)
        expect(result).toBe(false)
    })
})

describe('TomuxConnection.detach', () => {
    it('sends detach-client, never kill-*, ends released and releases once', async () => {
        const { tmux, conn } = await openFake()
        await conn.detach()
        expect(tmux.channel.commands).toContain('detach-client')
        expect(tmux.channel.commands.filter(c => KILL.test(c))).toEqual([])
        expect(conn.state).toBe('released')
        await expect(conn.closed).resolves.toBe('released')
        expect(tmux.releases).toBe(1)
        expect(tmux.channel.isClosed).toBe(true)
    })

    it('is idempotent', async () => {
        const { tmux, conn } = await openFake()
        await Promise.all([conn.detach(), conn.detach()])
        await conn.detach()
        expect(tmux.channel.commands.filter(c => c === 'detach-client')).toHaveLength(1)
        expect(tmux.releases).toBe(1)
    })

    it('closes the channel itself when tmux does not confirm within the timeout', async () => {
        vi.useFakeTimers()
        const tmux = new FakeTmux({ detachExits: false })
        tmux.overrides.set('detach-client', 'silent')
        const conn = await TomuxConnection.open(tmux, 'main', { detachTimeoutMs: 2000 })
        let done = false
        void conn.detach().then(() => { done = true })
        await vi.advanceTimersByTimeAsync(1999)
        expect(done).toBe(false)
        expect(tmux.channel.closeCalls).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(done).toBe(true)
        expect(conn.state).toBe('released')
        expect(tmux.channel.closeCalls).toBe(1)
        expect(tmux.releases).toBe(1)
    })

    it('tolerates a detach-client error', async () => {
        vi.useFakeTimers()
        const tmux = new FakeTmux({ detachExits: false })
        tmux.overrides.set('detach-client', { error: 'no current client' })
        const conn = await TomuxConnection.open(tmux, 'main')
        const detaching = conn.detach()
        await vi.advanceTimersByTimeAsync(2000)
        await expect(detaching).resolves.toBeUndefined()
        expect(conn.state).toBe('released')
    })

    it('keeps the terminal state of a connection that already ended', async () => {
        const { tmux, conn } = await openFake()
        tmux.channel.exit()
        await conn.closed
        await conn.detach()
        expect(conn.state).toBe('exited')
        expect(tmux.channel.commands).not.toContain('detach-client')
        expect(tmux.releases).toBe(1)
    })
})

describe('TomuxConnection events and window ownership', () => {
    it('surfaces window notifications', async () => {
        const { tmux, conn } = await openFake()
        const events: TomuxConnectionEvent[] = []
        conn.events$.subscribe(e => events.push(e))
        tmux.channel.send([
            '%window-add @4',
            '%window-renamed @4 logs',
            '%window-pane-changed @4 %9',
            '%session-window-changed $0 @4',
            '%window-close @4',
            '%output %9 hi',
        ].map(l => l + '\r\n').join(''))
        expect(events).toEqual([
            { type: 'window-add', windowId: '@4' },
            { type: 'window-renamed', windowId: '@4', name: 'logs' },
            { type: 'window-pane-changed', windowId: '@4', paneId: '%9' },
            { type: 'session-window-changed', sessionId: '$0', windowId: '@4' },
            { type: 'window-close', windowId: '@4' },
        ])
    })

    it('completes events$ when the connection ends', async () => {
        const { tmux, conn } = await openFake()
        let completed = false
        conn.events$.subscribe({ complete: () => { completed = true } })
        tmux.channel.exit()
        expect(completed).toBe(true)
    })

    it('claim / release / ownerOf', async () => {
        const { conn } = await openFake()
        const tabA = {}
        const tabB = {}
        expect(conn.ownerOf('@0')).toBeUndefined()
        expect(conn.claim('@0', tabA)).toBe(true)
        expect(conn.claim('@0', tabA)).toBe(true)
        expect(conn.claim('@0', tabB)).toBe(false)
        expect(conn.ownerOf('@0')).toBe(tabA)
        conn.release('@0', tabB)
        expect(conn.ownerOf('@0')).toBe(tabA)
        conn.release('@0', tabA)
        expect(conn.ownerOf('@0')).toBeUndefined()
        expect(conn.claim('@0', tabB)).toBe(true)
    })

    it('window-close clears ownership before listeners run', async () => {
        const { tmux, conn } = await openFake()
        const tab = {}
        conn.claim('@0', tab)
        conn.claim('@1', tab)
        let ownerSeen: object | undefined = tab
        conn.events$.subscribe(e => {
            if (e.type === 'window-close') {
                ownerSeen = conn.ownerOf(e.windowId)
            }
        })
        tmux.channel.send('%window-close @0\r\n')
        expect(ownerSeen).toBeUndefined()
        expect(conn.ownerOf('@0')).toBeUndefined()
        expect(conn.ownerOf('@1')).toBe(tab)
    })
})

describe('detectCreatedSession', () => {
    it.each([
        ['1700000100 1700000100', true],
        ['1700000101 1700000100', true],
        ['1700000000 1700000100', false],
        ['', false],
        [undefined, false],
        ['garbage', false],
    ])('%s → %s', (reply, expected) => {
        expect(detectCreatedSession(reply)).toBe(expected)
    })
})
