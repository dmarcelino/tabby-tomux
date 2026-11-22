// SPDX-License-Identifier: GPL-3.0-only
/**
 * Tells a user's tab close apart from every other way a tomux tab can go away
 * (design D6, verified in spike 3 against Tabby 1.0.238).
 *
 * Tabby's `destroyed$` cannot be trusted: closing the Tabby window destroys
 * every tab inside a split container with the event fired, exactly like a user
 * close. So tomux records positive evidence instead: it wraps
 * `AppService.closeTab` and marks the tabs under the closed tab while the call
 * runs. Every user-initiated close in Tabby (tab header button, middle click,
 * context menu Close / Close other / left / right, close-tab hotkey) calls
 * `closeTab(tab, true)`; `restartTab` is the only caller passing `false`, and
 * must not count. Tabby destroys the tabs synchronously inside the call, so a
 * tab's `destroyed$` handler must read `isUserClose()` synchronously.
 *
 * If the wrapper cannot be installed, `isInstalled` stays false and callers
 * must never kill: a wrongly kept tmux window costs one extra tab, a wrongly
 * killed one costs the user's work.
 */

interface TabLike {
    getAllTabs?: () => TabLike[]
}

export interface ClosableApp {
    closeTab: (tab: any, ...rest: any[]) => Promise<void>
}

const WRAPPED = Symbol('tomuxCloseIntentWrapped')

export class CloseIntentTracker {
    private marked = new WeakSet<object>()
    private installed = false

    get isInstalled (): boolean {
        return this.installed
    }

    /** Wraps `app.closeTab` once. Returns whether the wrapper is active. */
    install (app: ClosableApp): boolean {
        if (this.installed) {
            return true
        }
        const original = app.closeTab
        if (typeof original !== 'function' || (original as any)[WRAPPED]) {
            return false
        }
        const tracker = this
        const wrapped = async function (this: unknown, tab: TabLike, ...rest: unknown[]): Promise<void> {
            const userInitiated = rest[0] === true
            const tabs = userInitiated && tab ? descendants(tab) : []
            tabs.forEach(t => tracker.marked.add(t))
            try {
                // Forward every argument untouched (Tabby 1.0.238 has a third, ignorePinned).
                await original.call(app, tab, ...rest)
            } finally {
                tabs.forEach(t => tracker.marked.delete(t))
            }
        }
        ;(wrapped as any)[WRAPPED] = true
        app.closeTab = wrapped
        this.installed = true
        return true
    }

    /** True only while Tabby is closing this tab because the user asked to. */
    isUserClose (tab: object): boolean {
        return this.marked.has(tab)
    }
}

function descendants (tab: TabLike): TabLike[] {
    const children = typeof tab.getAllTabs === 'function' ? tab.getAllTabs() : []
    return [tab, ...children]
}
