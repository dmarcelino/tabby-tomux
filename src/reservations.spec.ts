// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { planAdoption, Reservations } from './reservations'

describe('Reservations', () => {
    it('keeps a window for its owner and refuses others', () => {
        const r = new Reservations()
        const a = {}, b = {}
        expect(r.reserve('k', '@1', a, 'bound')).toBe(true)
        expect(r.reserve('k', '@1', b, 'bound')).toBe(false)
        expect(r.isReservedByOther('k', '@1', a)).toBe(false)
        expect(r.isReservedByOther('k', '@1', b)).toBe(true)
        expect(r.isReservedByOther('other-key', '@1', b)).toBe(false)
    })

    it('lets the owner upgrade its own reservation (restore -> bound)', () => {
        const r = new Reservations()
        const a = {}
        r.reserve('k', '@1', a, 'restore')
        expect(r.reserve('k', '@1', a, 'bound')).toBe(true)
        expect(r.entries('k')).toEqual([{ windowId: '@1', owner: a, kind: 'bound' }])
    })

    it('only the owner can release', () => {
        const r = new Reservations()
        const a = {}, b = {}
        r.reserve('k', '@1', a, 'bound')
        r.release('k', '@1', b)
        expect(r.isReservedByOther('k', '@1', b)).toBe(true)
        r.release('k', '@1', a)
        expect(r.isReservedByOther('k', '@1', b)).toBe(false)
    })
})

describe('planAdoption', () => {
    it('opens tabs only for windows nobody owns or reserved', () => {
        const owner = {}
        const plan = planAdoption(['@1', '@2', '@3'], id => id === '@1', [{ windowId: '@2', owner, kind: 'bound' }])
        expect(plan.open).toEqual(['@3'])
    })

    it('does not duplicate windows of tabs that are still reconnecting (review item 10)', () => {
        // Three tabs opened with '+' are bound; the network drops; tab 1 reconnects first.
        const t1 = {}, t2 = {}, t3 = {}
        const reservations = [
            { windowId: '@1', owner: t1, kind: 'bound' as const },
            { windowId: '@2', owner: t2, kind: 'bound' as const },
            { windowId: '@3', owner: t3, kind: 'bound' as const },
        ]
        const plan = planAdoption(['@1', '@2', '@3'], id => id === '@1', reservations)
        expect(plan.open).toEqual([])
        expect(plan.close).toEqual([])
    })

    it('closes restored tabs whose window is gone, but never reopened ones (review item 17)', () => {
        const restored = {}, reopened = {}, bound = {}
        const plan = planAdoption(['@9'], () => false, [
            { windowId: '@4', owner: restored, kind: 'restore' },
            { windowId: '@5', owner: reopened, kind: 'reopen' },
            { windowId: '@6', owner: bound, kind: 'bound' },
        ])
        expect(plan.close).toEqual([restored])
        expect(plan.open).toEqual(['@9'])
    })
})
