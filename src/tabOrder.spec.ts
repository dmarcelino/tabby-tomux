// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { compareByRecordedOrder, openInOrder, planOrderWrites } from './tabOrder'

const w = (id: string, index: number, order: number | null) => ({ id, index, order })
const sorted = (windows: ReturnType<typeof w>[]) => [...windows].sort(compareByRecordedOrder).map(x => x.id)

describe('compareByRecordedOrder', () => {
    it('sorts by recorded order, not window number', () => {
        expect(sorted([w('@1', 0, 2), w('@2', 1, 0), w('@3', 2, 1)])).toEqual(['@2', '@3', '@1'])
    })

    it('breaks ties by window number', () => {
        expect(sorted([w('@5', 7, 1), w('@4', 3, 1), w('@6', 0, 0)])).toEqual(['@6', '@4', '@5'])
    })

    it('puts windows without an order after the ordered ones, by window number', () => {
        expect(sorted([w('@9', 6, null), w('@1', 0, 1), w('@8', 4, null), w('@2', 9, 0)])).toEqual(['@2', '@1', '@8', '@9'])
    })

    it('falls back to window-number order when nothing is recorded', () => {
        expect(sorted([w('@3', 2, null), w('@1', 0, null), w('@2', 1, null)])).toEqual(['@1', '@2', '@3'])
    })
})

describe('openInOrder', () => {
    function deferred<T> (): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
        let resolve!: (v: T) => void
        let reject!: (e: unknown) => void
        const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
        return { promise, resolve, reject }
    }

    it('starts every preparation at once and opens in id order even when they finish in reverse', async () => {
        const pending = new Map<string, ReturnType<typeof deferred<string>>>()
        const started: string[] = []
        const opened: [string, string][] = []
        const done = openInOrder(
            ['@2', '@3', '@1'],
            id => { started.push(id); const d = deferred<string>(); pending.set(id, d); return d.promise },
            (id, prepared) => opened.push([id, prepared]),
        )
        expect(started).toEqual(['@2', '@3', '@1'])
        pending.get('@1')!.resolve('in-1')
        pending.get('@3')!.resolve('in-3')
        await Promise.resolve()
        expect(opened).toEqual([])
        pending.get('@2')!.resolve('in-2')
        await done
        expect(opened).toEqual([['@2', 'in-2'], ['@3', 'in-3'], ['@1', 'in-1']])
    })

    it('skips items whose preparation failed and still opens the rest in order', async () => {
        const opened: string[] = []
        await openInOrder(
            ['@1', '@2', '@3'],
            async id => { if (id === '@2') { throw new Error('no profile') } return id },
            id => opened.push(id),
        )
        expect(opened).toEqual(['@1', '@3'])
    })

    it('opens everything inside a single batch call', async () => {
        const log: string[] = []
        await openInOrder(
            ['@1', '@2'],
            async id => id,
            id => log.push(`open ${id}`),
            openAll => { log.push('enter'); openAll(); log.push('leave') },
        )
        expect(log).toEqual(['enter', 'open @1', 'open @2', 'leave'])
    })

    it('keeps opening after one open throws, and reports every failure', async () => {
        const opened: string[] = []
        const boom = new Error('component init failed')
        const failures = await openInOrder(
            ['@1', '@2', '@3'],
            async id => { if (id === '@3') { throw new Error('no profile') } return id },
            id => { if (id === '@1') { throw boom } opened.push(id) },
        )
        expect(opened).toEqual(['@2'])
        expect(failures.map(f => f.id)).toEqual(['@1', '@3'])
        expect(failures[0].error).toBe(boom)
    })
})

describe('planOrderWrites', () => {
    const tab = (name: string) => ({ name })
    const [t1, t2, t3, other] = [tab('t1'), tab('t2'), tab('t3'), tab('other session')]
    const owned: [string, object][] = [['@1', t1], ['@2', t2], ['@3', t3]]
    const recorded = (...pairs: [string, number][]) => new Map(pairs)

    it('writes every window the first time', () => {
        expect(planOrderWrites([t1, t2, t3], owned, recorded())).toEqual([['@1', 0], ['@2', 1], ['@3', 2]])
    })

    it('returns nothing when tmux already has the bar order', () => {
        expect(planOrderWrites([t1, t2, t3], owned, recorded(['@1', 0], ['@2', 1], ['@3', 2]))).toEqual([])
    })

    it('rewrites every shifted window after a drag to the far left', () => {
        expect(planOrderWrites([t3, t1, t2], owned, recorded(['@1', 0], ['@2', 1], ['@3', 2])))
            .toEqual([['@3', 0], ['@1', 1], ['@2', 2]])
    })

    it('rewrites every window after a hotkey move, not only the two swapped ones', () => {
        // @3 looks unchanged, but another Tabby window may have written @3=0
        // since: sending only @2 and @1 would leave @2 and @3 both at 0.
        expect(planOrderWrites([t2, t1, t3], owned, recorded(['@1', 0], ['@2', 1], ['@3', 2])))
            .toEqual([['@2', 0], ['@1', 1], ['@3', 2]])
    })

    it('counts only this connection\'s tabs', () => {
        expect(planOrderWrites([t2, other, t1], [['@1', t1], ['@2', t2]], recorded()))
            .toEqual([['@2', 0], ['@1', 1]])
    })

    it('closes the gap a closed tab left', () => {
        expect(planOrderWrites([t1, t3], [['@1', t1], ['@3', t3]], recorded(['@1', 0], ['@2', 1], ['@3', 2])))
            .toEqual([['@1', 0], ['@3', 1]])
    })

    it('keeps the position of a tab that has only reserved its window (not shown yet)', () => {
        // @2's tab sits in the bar but has not connected: without its
        // reservation, @3 would be squeezed into 1 and clash with @2's 1.
        const ownedNow: [string, object][] = [['@1', t1], ['@3', t3]]
        const reserved: [string, object][] = [['@2', t2]]
        expect(planOrderWrites([t1, t2, t3], [...ownedNow, ...reserved], recorded(['@1', 0], ['@2', 1], ['@3', 2])))
            .toEqual([])
    })

    it('counts a window listed both as owned and as reserved once', () => {
        expect(planOrderWrites([t1, t2], [['@1', t1], ['@2', t2], ['@1', t1]], recorded()))
            .toEqual([['@1', 0], ['@2', 1]])
    })

    it('leaves alone a window whose tab is not in this Tabby window', () => {
        const elsewhere = tab('second Tabby window')
        expect(planOrderWrites([t1, t2], [...owned.slice(0, 2), ['@9', elsewhere]], recorded(['@9', 0])))
            .toEqual([['@1', 0], ['@2', 1]])
    })
})
