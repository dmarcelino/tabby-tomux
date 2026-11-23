// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { SingleFlight } from './singleFlight'

function deferred (): { promise: Promise<void>, resolve: () => void, reject: (e: Error) => void } {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

describe('SingleFlight', () => {
    it('joins a call made while the work is running instead of starting it again', async () => {
        const flight = new SingleFlight()
        const gate = deferred()
        let starts = 0
        const work = async () => { starts++; await gate.promise }
        const a = flight.run(work)
        const b = flight.run(work)
        expect(b).toBe(a)
        expect(flight.running).toBe(true)
        gate.resolve()
        await Promise.all([a, b])
        expect(starts).toBe(1)
        expect(flight.running).toBe(false)
    })

    it('starts the work again once the previous run finished', async () => {
        const flight = new SingleFlight()
        let starts = 0
        await flight.run(async () => { starts++ })
        await flight.run(async () => { starts++ })
        expect(starts).toBe(2)
    })

    it('a call made from inside the running work joins it (reconnect from reconnect)', async () => {
        const flight = new SingleFlight()
        let starts = 0
        let inner: Promise<void> | null = null
        const work = async (): Promise<void> => {
            starts++
            inner = flight.run(work)
        }
        await flight.run(work)
        await inner
        expect(starts).toBe(1)
    })

    it('frees itself after the work fails, and passes the failure to every caller', async () => {
        const flight = new SingleFlight()
        const gate = deferred()
        const a = flight.run(() => gate.promise)
        const b = flight.run(() => gate.promise)
        gate.reject(new Error('login failed'))
        await expect(a).rejects.toThrow('login failed')
        await expect(b).rejects.toThrow('login failed')
        expect(flight.running).toBe(false)
    })

    it('treats work that throws synchronously like a failed run', async () => {
        const flight = new SingleFlight()
        await expect(flight.run(() => { throw new Error('boom') })).rejects.toThrow('boom')
        expect(flight.running).toBe(false)
    })
})
