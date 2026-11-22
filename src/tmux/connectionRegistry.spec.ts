// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TomuxConnection } from './connection'
import { ConnectionRegistry, connectionKey } from './connectionRegistry'
import { FakeTmux, FakeTmuxOptions } from './fakeTmux.testing'

const KEY = 'host:main'

/** A factory over one fake host; every call opens a new control channel. */
function fakeFactory (opts: FakeTmuxOptions = {}): { tmux: FakeTmux, factory: () => Promise<TomuxConnection>, calls: () => number } {
    const tmux = new FakeTmux(opts)
    let calls = 0
    return {
        tmux,
        factory: () => {
            calls++
            return TomuxConnection.open(tmux, 'main')
        },
        calls: () => calls,
    }
}

function allCommands (tmux: FakeTmux): string[] {
    return tmux.channels.flatMap(c => c.commands)
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('connectionKey', () => {
    const base = { options: { host: 'h', port: 22, user: 'u' } }

    it('is the same for equivalent profiles and defaults the port to 22', () => {
        expect(connectionKey({ options: { host: 'h', user: 'u' } }, 'main')).toBe(connectionKey(base, 'main'))
    })

    it.each([
        ['host', { ...base.options, host: 'h2' }],
        ['port', { ...base.options, port: 2222 }],
        ['user', { ...base.options, user: 'v' }],
        ['proxyCommand', { ...base.options, proxyCommand: 'nc %h %p' }],
        ['socksProxyHost', { ...base.options, socksProxyHost: 'p' }],
        ['socksProxyPort', { ...base.options, socksProxyPort: 1080 }],
        ['httpProxyHost', { ...base.options, httpProxyHost: 'p' }],
        ['httpProxyPort', { ...base.options, httpProxyPort: 3128 }],
        ['jumpHost', { ...base.options, jumpHost: 'profile-id' }],
    ])('differs by %s', (_field, options) => {
        expect(connectionKey({ options }, 'main')).not.toBe(connectionKey(base, 'main'))
    })

    it('differs by session name', () => {
        expect(connectionKey(base, 'main')).not.toBe(connectionKey(base, 'work'))
    })

    it('does not confuse field boundaries', () => {
        const a = connectionKey({ options: { host: 'a:1', user: 'u' } }, 'main')
        const b = connectionKey({ options: { host: 'a', user: '1:u' } }, 'main')
        expect(a).not.toBe(b)
    })
})

describe('ConnectionRegistry.acquire', () => {
    it('shares one factory call between concurrent callers', async () => {
        const registry = new ConnectionRegistry()
        const { tmux, factory, calls } = fakeFactory()
        const results = await Promise.all(Array.from({ length: 5 }, () => registry.acquire(KEY, factory)))
        expect(calls()).toBe(1)
        expect(tmux.channels).toHaveLength(1)
        expect(new Set(results).size).toBe(1)
        expect(registry.refCount(KEY)).toBe(5)
    })

    it('keeps separate connections per key', async () => {
        const registry = new ConnectionRegistry()
        const a = fakeFactory()
        const b = fakeFactory()
        const [ca, cb] = await Promise.all([registry.acquire('k1', a.factory), registry.acquire('k2', b.factory)])
        expect(ca).not.toBe(cb)
        expect(a.calls()).toBe(1)
        expect(b.calls()).toBe(1)
    })

    it('reuses a live connection after a successful ping', async () => {
        const registry = new ConnectionRegistry()
        const { tmux, factory, calls } = fakeFactory()
        const first = await registry.acquire(KEY, factory)
        const second = await registry.acquire(KEY, factory)
        expect(second).toBe(first)
        expect(calls()).toBe(1)
        expect(tmux.channel.commands).toContain('display-message -p "__ping__"')
    })

    it('replaces a connection whose ping times out, detaching (never killing) the old one', async () => {
        const registry = new ConnectionRegistry()
        const { tmux, factory, calls } = fakeFactory({ ping: 'silent' })
        const first = await registry.acquire(KEY, factory)
        const acquiring = registry.acquire(KEY, factory)
        await vi.advanceTimersByTimeAsync(5000)
        const second = await acquiring
        expect(second).not.toBe(first)
        expect(calls()).toBe(2)
        await vi.advanceTimersByTimeAsync(2000)
        expect(first.state).toBe('released')
        expect(second.isLive).toBe(true)
        expect(tmux.channels[0].commands).toContain('detach-client')
        expect(allCommands(tmux).filter(c => /^kill-/u.test(c))).toEqual([])
        expect(registry.refCount(KEY)).toBe(2)
    })

    it('keeps a busy connection whose ping reply is late but data keeps arriving', async () => {
        const registry = new ConnectionRegistry({ pingTimeoutMs: 5000 })
        const { tmux, factory, calls } = fakeFactory({ ping: 'silent' })
        const first = await registry.acquire(KEY, factory)
        const acquiring = registry.acquire(KEY, factory)
        for (let i = 0; i < 12; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            tmux.channel.send('%output %0 busy\r\n')
        }
        tmux.channel.reply(['__ping__'])
        await expect(acquiring).resolves.toBe(first)
        expect(calls()).toBe(1)
        expect(first.isLive).toBe(true)
        expect(tmux.channel.commands).not.toContain('detach-client')
    })

    it('replaces a connection whose ping fails with an error', async () => {
        const registry = new ConnectionRegistry()
        const { factory, calls } = fakeFactory({ ping: 'error' })
        const first = await registry.acquire(KEY, factory)
        const second = await registry.acquire(KEY, factory)
        expect(second).not.toBe(first)
        expect(calls()).toBe(2)
    })

    it('removes an ended connection so the next acquire reconnects', async () => {
        const registry = new ConnectionRegistry()
        const { tmux, factory, calls } = fakeFactory()
        const first = await registry.acquire(KEY, factory)
        tmux.channel.exit()
        await first.closed
        expect(registry.peek(KEY)).toBeUndefined()
        const second = await registry.acquire(KEY, factory)
        expect(second).not.toBe(first)
        expect(calls()).toBe(2)
        // The ended connection was not pinged.
        expect(tmux.channels[0].commands).not.toContain('display-message -p "__ping__"')
    })

    it('drops the reference of a failed acquire and lets the next one retry', async () => {
        const registry = new ConnectionRegistry()
        const bad = fakeFactory({ version: 'tmux 1.8' })
        await expect(Promise.all([registry.acquire(KEY, bad.factory), registry.acquire(KEY, bad.factory)])).rejects.toThrow(/1\.8/u)
        expect(bad.calls()).toBe(1)
        expect(registry.refCount(KEY)).toBe(0)
        const good = fakeFactory()
        await expect(registry.acquire(KEY, good.factory)).resolves.toBeDefined()
        expect(registry.refCount(KEY)).toBe(1)
    })
})

describe('ConnectionRegistry.releaseRef', () => {
    it('detaches after the idle delay once the last reference is released', async () => {
        const registry = new ConnectionRegistry({ idleDelayMs: 3000 })
        const { tmux, factory } = fakeFactory()
        const conn = await registry.acquire(KEY, factory)
        await registry.acquire(KEY, factory)
        registry.releaseRef(KEY)
        await vi.advanceTimersByTimeAsync(5000)
        expect(conn.isLive).toBe(true)
        registry.releaseRef(KEY)
        await vi.advanceTimersByTimeAsync(2999)
        expect(conn.isLive).toBe(true)
        expect(tmux.channel.commands).not.toContain('detach-client')
        await vi.advanceTimersByTimeAsync(1)
        await conn.closed
        expect(conn.state).toBe('released')
        expect(tmux.channel.commands).toContain('detach-client')
        expect(allCommands(tmux).filter(c => /^kill-/u.test(c))).toEqual([])
        expect(tmux.releases).toBe(1)
        expect(registry.peek(KEY)).toBeUndefined()
        expect(registry.refCount(KEY)).toBe(0)
    })

    it('cancels the pending detach when re-acquired within the idle delay', async () => {
        const registry = new ConnectionRegistry({ idleDelayMs: 3000 })
        const { tmux, factory, calls } = fakeFactory()
        const conn = await registry.acquire(KEY, factory)
        registry.releaseRef(KEY)
        await vi.advanceTimersByTimeAsync(2000)
        const again = await registry.acquire(KEY, factory)
        expect(again).toBe(conn)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(conn.isLive).toBe(true)
        expect(calls()).toBe(1)
        expect(tmux.channel.commands).not.toContain('detach-client')
    })

    it('a new acquire after the idle detach opens a fresh connection', async () => {
        const registry = new ConnectionRegistry({ idleDelayMs: 100 })
        const { factory, calls } = fakeFactory()
        const first = await registry.acquire(KEY, factory)
        registry.releaseRef(KEY)
        await vi.advanceTimersByTimeAsync(100)
        const second = await registry.acquire(KEY, factory)
        expect(second).not.toBe(first)
        expect(calls()).toBe(2)
    })

    it('forgets the key when the last reference goes after the connection ended', async () => {
        const registry = new ConnectionRegistry()
        const { tmux, factory } = fakeFactory()
        const conn = await registry.acquire(KEY, factory)
        tmux.channel.remoteClose()
        await conn.closed
        registry.releaseRef(KEY)
        registry.releaseRef(KEY)
        expect(registry.refCount(KEY)).toBe(0)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(tmux.channel.commands).not.toContain('detach-client')
    })

    it('ignores extra releases', async () => {
        const registry = new ConnectionRegistry()
        const { factory } = fakeFactory()
        await registry.acquire(KEY, factory)
        registry.releaseRef(KEY)
        registry.releaseRef(KEY)
        registry.releaseRef('unknown')
        expect(registry.refCount(KEY)).toBe(0)
    })
})
