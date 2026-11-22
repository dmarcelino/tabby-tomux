// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { CloseIntentTracker } from './closeIntent'

/** Minimal stand-in for Tabby's AppService.closeTab: optionally refuses, else destroys synchronously. */
function fakeApp (opts: { refuse?: boolean } = {}) {
    const seen: { tab: any, marked: boolean }[] = []
    const app = {
        tracker: null as CloseIntentTracker | null,
        async closeTab (tab: any, checkCanClose?: boolean, _ignorePinned?: boolean): Promise<void> {
            await Promise.resolve()
            if (opts.refuse) {
                return
            }
            for (const t of [tab, ...(tab.getAllTabs?.() ?? [])]) {
                seen.push({ tab: t, marked: app.tracker!.isUserClose(t) })
            }
            void checkCanClose
        },
    }
    return { app, seen }
}

describe('CloseIntentTracker', () => {
    it('marks the tab and its children during a user close (checkCanClose=true)', async () => {
        const { app, seen } = fakeApp()
        const tracker = new CloseIntentTracker()
        app.tracker = tracker
        expect(tracker.install(app)).toBe(true)
        const child = {}
        const split = { getAllTabs: () => [child] }
        await app.closeTab(split, true)
        expect(seen.map(s => s.marked)).toEqual([true, true])
        expect(tracker.isUserClose(split)).toBe(false)
        expect(tracker.isUserClose(child)).toBe(false)
    })

    it('does not mark restart-tab closes (checkCanClose=false)', async () => {
        const { app, seen } = fakeApp()
        const tracker = new CloseIntentTracker()
        app.tracker = tracker
        tracker.install(app)
        const tab = {}
        await app.closeTab(tab, false, true)
        expect(seen).toEqual([{ tab, marked: false }])
    })

    it('does not mark closes without arguments (other callers)', async () => {
        const { app, seen } = fakeApp()
        const tracker = new CloseIntentTracker()
        app.tracker = tracker
        tracker.install(app)
        await app.closeTab({})
        expect(seen[0].marked).toBe(false)
    })

    it('leaves no stale mark when the close is refused', async () => {
        const { app } = fakeApp({ refuse: true })
        const tracker = new CloseIntentTracker()
        app.tracker = tracker
        tracker.install(app)
        const tab = {}
        await app.closeTab(tab, true)
        expect(tracker.isUserClose(tab)).toBe(false)
    })

    it('clears marks when closeTab throws', async () => {
        const tracker = new CloseIntentTracker()
        const app = { closeTab: async (..._args: unknown[]) => { throw new Error('boom') } }
        tracker.install(app)
        const tab = {}
        await expect(app.closeTab(tab, true)).rejects.toThrow('boom')
        expect(tracker.isUserClose(tab)).toBe(false)
    })

    it('forwards every argument and the return value', async () => {
        const calls: unknown[][] = []
        const app = { closeTab: async (...args: unknown[]) => { calls.push(args) } }
        new CloseIntentTracker().install(app)
        const tab = {}
        await app.closeTab(tab, false, true)
        expect(calls).toEqual([[tab, false, true]])
    })

    it('installs once and refuses to wrap an already wrapped closeTab', () => {
        const { app } = fakeApp()
        const a = new CloseIntentTracker()
        expect(a.install(app)).toBe(true)
        expect(a.install(app)).toBe(true)
        const b = new CloseIntentTracker()
        expect(b.install(app)).toBe(false)
        expect(b.isInstalled).toBe(false)
    })

    it('reports not installed when closeTab is missing', () => {
        const tracker = new CloseIntentTracker()
        expect(tracker.install({} as any)).toBe(false)
        expect(tracker.isInstalled).toBe(false)
    })
})
