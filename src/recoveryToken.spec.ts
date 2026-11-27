// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { BindIntent } from './binding'
import { intentFromToken, isTomuxToken, makeRecoveryToken } from './recoveryToken'

const base = {
    tomuxProfileId: 'tomux:work',
    sessionName: 'main',
    windowId: '@4',
    intent: { kind: 'adopt', windowId: '@4' } as BindIntent,
}

describe('recovery tokens', () => {
    it('duplicate / split (no includeState) -> no window id -> new window', () => {
        const t = makeRecoveryToken({ ...base, includeState: false, userClosed: false })
        expect(t).toEqual({ type: 'app:tomux-tab', tomuxProfileId: 'tomux:work', sessionName: 'main' })
        expect(intentFromToken(t)).toEqual({ kind: 'new' })
    })

    it('saved for restore or restart -> adopt the same window', () => {
        const t = makeRecoveryToken({ ...base, includeState: true, userClosed: false })
        expect(t.windowId).toBe('@4')
        expect(t.userClosed).toBeUndefined()
        expect(intentFromToken(t)).toEqual({ kind: 'adopt', windowId: '@4' })
    })

    it('closed by the user (reopen stack) -> reopen', () => {
        const t = makeRecoveryToken({ ...base, includeState: true, userClosed: true })
        expect(intentFromToken(t)).toEqual({ kind: 'reopen', windowId: '@4' })
    })

    it('a tab for a new window not yet bound saves no window id', () => {
        const t = makeRecoveryToken({ ...base, windowId: null, intent: { kind: 'new' }, includeState: true, userClosed: false })
        expect(t.windowId).toBeUndefined()
        expect(intentFromToken(t)).toEqual({ kind: 'new' })
    })

    it('an unbound adopt tab saves its window and restores as adopt', () => {
        const t = makeRecoveryToken({
            ...base, windowId: null, intent: { kind: 'adopt', windowId: '@2' }, includeState: true, userClosed: false,
        })
        expect(t.windowId).toBe('@2')
        expect(t.userClosed).toBeUndefined()
        expect(intentFromToken(t)).toEqual({ kind: 'adopt', windowId: '@2' })
    })

    it('an unbound reopen tab saves its window and restores as adopt', () => {
        const t = makeRecoveryToken({
            ...base, windowId: null, intent: { kind: 'reopen', windowId: '@2' }, includeState: true, userClosed: false,
        })
        expect(t.windowId).toBe('@2')
        expect(t.userClosed).toBeUndefined()
        expect(intentFromToken(t)).toEqual({ kind: 'adopt', windowId: '@2' })
    })

    it('an unbound tab closed by the user restores as reopen of its window', () => {
        const t = makeRecoveryToken({
            ...base, windowId: null, intent: { kind: 'adopt', windowId: '@2' }, includeState: true, userClosed: true,
        })
        expect(t.userClosed).toBe(true)
        expect(intentFromToken(t)).toEqual({ kind: 'reopen', windowId: '@2' })
    })

    it('a bound tab saves its bound window, not its intent window', () => {
        const t = makeRecoveryToken({
            ...base, windowId: '@9', intent: { kind: 'reopen', windowId: '@2' }, includeState: true, userClosed: false,
        })
        expect(t.windowId).toBe('@9')
        expect(intentFromToken(t)).toEqual({ kind: 'adopt', windowId: '@9' })
    })

    it('without includeState saves no window whatever the intent', () => {
        const intents: BindIntent[] = [
            { kind: 'adopt', windowId: '@2' },
            { kind: 'reopen', windowId: '@2' },
            { kind: 'new' },
        ]
        for (const intent of intents) {
            for (const windowId of ['@4', null]) {
                const t = makeRecoveryToken({ ...base, windowId, intent, includeState: false, userClosed: true })
                expect(t.windowId).toBeUndefined()
                expect(t.userClosed).toBeUndefined()
            }
        }
    })

    it('never carries saved screen state', () => {
        const t = makeRecoveryToken({ ...base, includeState: true, userClosed: false }) as any
        expect(t.savedState).toBeUndefined()
    })

    it('recognises only well-formed tomux tokens', () => {
        expect(isTomuxToken(makeRecoveryToken({ ...base, includeState: true, userClosed: false }))).toBe(true)
        expect(isTomuxToken({ type: 'app:ssh-tab' })).toBe(false)
        expect(isTomuxToken({ type: 'app:tomux-tab' })).toBe(false)
    })
})
