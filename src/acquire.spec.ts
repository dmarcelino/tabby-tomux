// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireTracked } from './acquire'
import { TomuxConnection } from './tmux/connection'
import { ConnectionRegistry } from './tmux/connectionRegistry'
import { FakeTmux } from './tmux/fakeTmux.testing'

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('acquireTracked (review item 14)', () => {
    it('reports opened=true for exactly one of several concurrent callers', async () => {
        const registry = new ConnectionRegistry()
        const tmux = new FakeTmux()
        const open = () => TomuxConnection.open(tmux, 'main')
        const results = await Promise.all(Array.from({ length: 4 }, () => acquireTracked(registry, 'k', open)))
        expect(results.filter(r => r.opened)).toHaveLength(1)
        expect(new Set(results.map(r => r.conn)).size).toBe(1)
    })

    it('reports opened=false when the connection already exists', async () => {
        const registry = new ConnectionRegistry()
        const tmux = new FakeTmux()
        const open = () => TomuxConnection.open(tmux, 'main')
        const first = await acquireTracked(registry, 'k', open)
        const later = acquireTracked(registry, 'k', open)
        await vi.advanceTimersByTimeAsync(10)
        const second = await later
        expect(first.opened).toBe(true)
        expect(second.opened).toBe(false)
        expect(second.conn).toBe(first.conn)
    })
})
