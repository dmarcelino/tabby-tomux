// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { intentFromToken, isTomuxToken, makeRecoveryToken } from './recoveryToken'

const base = { tomuxProfileId: 'tomux:work', sessionName: 'main', windowId: '@4' }

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

    it('a tab not yet bound to a window saves no window id', () => {
        const t = makeRecoveryToken({ ...base, windowId: null, includeState: true, userClosed: false })
        expect(intentFromToken(t)).toEqual({ kind: 'new' })
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
