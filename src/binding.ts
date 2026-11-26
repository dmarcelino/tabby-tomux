// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which tmux window a tomux tab binds to (design D5, specs tmux-window-tabs,
 * tmux-tab-recovery and tomux-profile). Pure, so every rule is unit-tested.
 */
import { compareByRecordedOrder } from './tabOrder'
import type { TmuxWindow } from './tmux/controlClient'

export type BindIntent =
    /** Startup restore or restart tab: this exact window, or nothing. */
    | { kind: 'adopt', windowId: string }
    /** Reopen closed tab: this window if it is still there, else a new one. */
    | { kind: 'reopen', windowId: string }
    /** Profile open, `+`, duplicate, split: a new window (see firstBind). */
    | { kind: 'new' }

export type BindDecision =
    | { action: 'bind', window: TmuxWindow }
    | { action: 'create' }
    | { action: 'close', reason: string }

export interface BindContext {
    intent: BindIntent
    /** Current windows of the session, in any order. */
    windows: TmuxWindow[]
    isOwned: (windowId: string) => boolean
    /**
     * True for the first `new` bind on a connection this tab caused to open:
     * then the tab takes an existing window instead of creating one (the
     * session's only window if the connection created the session, otherwise
     * its first unclaimed window in recorded tab order, see tabOrder.ts).
     */
    firstBind: boolean
}

/**
 * The intent for a (re)connect of a tab. Once a tab has shown a window, every
 * later connect (Reconnect, or a dropped connection coming back) comes back to
 * that window or closes the tab; it never creates another (spec
 * tmux-tab-ssh-tools, "Reconnect re-attaches the tab's window").
 */
export function connectIntent (current: BindIntent, boundWindowId: string | null): BindIntent {
    return boundWindowId ? { kind: 'adopt', windowId: boundWindowId } : current
}

/** The intent for the log: "new", "adopt @3", "reopen @4". */
export function describeIntent (intent: BindIntent): string {
    return intent.kind === 'new' ? 'new' : `${intent.kind} ${intent.windowId}`
}

export function decideBinding (ctx: BindContext): BindDecision {
    const { intent, windows, isOwned } = ctx
    const free = (id: string) => windows.find(w => w.id === id && !isOwned(w.id))

    switch (intent.kind) {
        case 'adopt': {
            const w = free(intent.windowId)
            return w
                ? { action: 'bind', window: w }
                : { action: 'close', reason: `tmux window ${intent.windowId} no longer exists or is shown in another tab` }
        }
        case 'reopen': {
            const w = free(intent.windowId)
            return w ? { action: 'bind', window: w } : { action: 'create' }
        }
        case 'new': {
            if (ctx.firstBind) {
                const unclaimed = windows
                    .filter(w => !isOwned(w.id))
                    .sort(compareByRecordedOrder)
                if (unclaimed.length) {
                    return { action: 'bind', window: unclaimed[0] }
                }
            }
            return { action: 'create' }
        }
    }
}

/** Windows no tab has claimed, in recorded tab order (tabOrder.ts): opened as extra tabs after restore. */
export function unclaimedWindows (windows: TmuxWindow[], isOwned: (windowId: string) => boolean): TmuxWindow[] {
    return windows.filter(w => !isOwned(w.id)).sort(compareByRecordedOrder)
}
