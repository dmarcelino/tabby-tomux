// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { decideBinding, unclaimedWindows } from './binding'
import type { TmuxWindow } from './tmux/controlClient'

const win = (id: string, index: number): TmuxWindow => ({ id, index, name: `w${index}`, paneId: `%${index}`, active: false, automaticRename: true })
const windows = [win('@3', 2), win('@1', 0), win('@2', 1)]
const owned = (...ids: string[]) => (id: string) => ids.includes(id)

describe('decideBinding', () => {
    it('adopt binds the exact window when it exists and is free', () => {
        expect(decideBinding({ intent: { kind: 'adopt', windowId: '@2' }, windows, isOwned: owned(), firstBind: false }))
            .toEqual({ action: 'bind', window: win('@2', 1) })
    })

    it('adopt closes the tab when the window is gone (never creates one)', () => {
        const d = decideBinding({ intent: { kind: 'adopt', windowId: '@9' }, windows, isOwned: owned(), firstBind: true })
        expect(d.action).toBe('close')
    })

    it('adopt closes the tab when another tab holds the window', () => {
        const d = decideBinding({ intent: { kind: 'adopt', windowId: '@2' }, windows, isOwned: owned('@2'), firstBind: false })
        expect(d.action).toBe('close')
    })

    it('reopen binds the window if it survived, else creates a new one', () => {
        expect(decideBinding({ intent: { kind: 'reopen', windowId: '@1' }, windows, isOwned: owned(), firstBind: false }))
            .toEqual({ action: 'bind', window: win('@1', 0) })
        expect(decideBinding({ intent: { kind: 'reopen', windowId: '@9' }, windows, isOwned: owned(), firstBind: false }))
            .toEqual({ action: 'create' })
        expect(decideBinding({ intent: { kind: 'reopen', windowId: '@1' }, windows, isOwned: owned('@1'), firstBind: false }))
            .toEqual({ action: 'create' })
    })

    it('new on an already connected session creates a window', () => {
        expect(decideBinding({ intent: { kind: 'new' }, windows, isOwned: owned(), firstBind: false }))
            .toEqual({ action: 'create' })
    })

    it('first new bind takes the lowest-numbered unclaimed window', () => {
        expect(decideBinding({ intent: { kind: 'new' }, windows, isOwned: owned('@1'), firstBind: true }))
            .toEqual({ action: 'bind', window: win('@2', 1) })
    })

    it('first new bind on a just-created session takes its only window', () => {
        expect(decideBinding({ intent: { kind: 'new' }, windows: [win('@0', 0)], isOwned: owned(), firstBind: true }))
            .toEqual({ action: 'bind', window: win('@0', 0) })
    })

    it('first new bind creates a window when every window is taken', () => {
        expect(decideBinding({ intent: { kind: 'new' }, windows, isOwned: owned('@1', '@2', '@3'), firstBind: true }))
            .toEqual({ action: 'create' })
    })
})

describe('unclaimedWindows', () => {
    it('returns free windows in index order', () => {
        expect(unclaimedWindows(windows, owned('@2')).map(w => w.id)).toEqual(['@1', '@3'])
    })
})
