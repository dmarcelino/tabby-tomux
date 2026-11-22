// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which tab intends to show which tmux window, per connection key, for as
 * long as the tab lives (design D5, "Reservations").
 *
 * A reservation outlives the control connection: a restored tab that has not
 * been shown yet, or a tab waiting to reconnect after a network drop, keeps
 * its window so that nobody else (leftover adoption, %window-add, another
 * tab's binding) takes it meanwhile.
 *
 *   kind 'restore' - a restored tab, not yet bound: if its window is gone when
 *                    the session connects, the tab closes (spec: it does not
 *                    come back).
 *   kind 'reopen'  - a reopened closed tab, not yet bound: if its window is
 *                    gone it creates a new one instead, so it is never closed.
 *   kind 'bound'   - any tab currently bound to the window.
 */
export type ReservationKind = 'restore' | 'reopen' | 'bound'

interface Reservation {
    owner: object
    kind: ReservationKind
}

export class Reservations {
    private byKey = new Map<string, Map<string, Reservation>>()

    /** Reserves `windowId` for `owner`. Returns false if another owner holds it. */
    reserve (key: string, windowId: string, owner: object, kind: ReservationKind): boolean {
        let byWindow = this.byKey.get(key)
        if (!byWindow) {
            byWindow = new Map()
            this.byKey.set(key, byWindow)
        }
        const current = byWindow.get(windowId)
        if (current && current.owner !== owner) {
            return false
        }
        byWindow.set(windowId, { owner, kind })
        return true
    }

    release (key: string, windowId: string, owner: object): void {
        const byWindow = this.byKey.get(key)
        if (byWindow?.get(windowId)?.owner === owner) {
            byWindow.delete(windowId)
            if (!byWindow.size) {
                this.byKey.delete(key)
            }
        }
    }

    /** True when an owner other than `except` holds the window. */
    isReservedByOther (key: string, windowId: string, except?: object): boolean {
        const r = this.byKey.get(key)?.get(windowId)
        return !!r && r.owner !== except
    }

    entries (key: string): { windowId: string, owner: object, kind: ReservationKind }[] {
        return [...this.byKey.get(key)?.entries() ?? []].map(([windowId, r]) => ({ windowId, ...r }))
    }
}

/**
 * What to do once a connection has the session's current window list:
 * open a tab for every window nobody owns or reserved, and close restored
 * tabs whose window disappeared while Tabby was not running.
 */
export function planAdoption (
    windowIds: string[],
    isOwned: (windowId: string) => boolean,
    reservations: { windowId: string, owner: object, kind: ReservationKind }[],
): { open: string[], close: object[] } {
    const reserved = new Set(reservations.map(r => r.windowId))
    const present = new Set(windowIds)
    return {
        open: windowIds.filter(id => !isOwned(id) && !reserved.has(id)),
        close: reservations.filter(r => r.kind === 'restore' && !present.has(r.windowId)).map(r => r.owner),
    }
}
