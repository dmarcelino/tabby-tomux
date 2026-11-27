// SPDX-License-Identifier: GPL-3.0-only
/**
 * Tab order kept in tmux (change restore-tab-order, design D3-D5). Each
 * window's `@tomux-order` holds its tab's position among its session's tabs
 * in the Tabby window that last recorded it (change record-order-other-windows);
 * tabs tomux opens itself follow it. Pure, so every rule is unit-tested; the
 * service wires it to Tabby and tmux.
 */
import type { TmuxWindow } from './tmux/controlClient'

/**
 * Windows with a recorded order first, ascending; then windows without one.
 * Ties, and windows without an order, go by window number.
 */
export function compareByRecordedOrder (a: Pick<TmuxWindow, 'index' | 'order'>, b: Pick<TmuxWindow, 'index' | 'order'>): number {
    if (a.order !== null && b.order !== null && a.order !== b.order) {
        return a.order - b.order
    }
    if ((a.order === null) !== (b.order === null)) {
        return a.order === null ? 1 : -1
    }
    return a.index - b.index
}

/**
 * Prepares every item in parallel, then opens them in the order of `ids`
 * once all preparations have settled, so where each tab lands does not depend
 * on which preparation finished first (design D4). An item whose preparation
 * rejects or whose `open` throws is skipped without stopping the others; the
 * failures are returned for logging. `batch` wraps the whole opening loop, for
 * running it in one Angular zone turn.
 */
export async function openInOrder<T> (
    ids: readonly string[],
    prepare: (id: string) => Promise<T>,
    open: (id: string, prepared: T) => void,
    batch: (openAll: () => void) => void = openAll => openAll(),
): Promise<{ id: string, error: unknown }[]> {
    const results = await Promise.allSettled(ids.map(id => prepare(id)))
    const failures: { id: string, error: unknown }[] = []
    batch(() => {
        results.forEach((result, i) => {
            if (result.status === 'rejected') {
                failures.push({ id: ids[i], error: result.reason })
                return
            }
            try {
                open(ids[i], result.value)
            } catch (error) {
                failures.push({ id: ids[i], error })
            }
        })
    })
    return failures
}

/**
 * The `@tomux-order` writes one connection needs so that its windows' values
 * match the tab bar (design D5). `barTabs` are Tabby's tabs in bar order with
 * split containers already flattened; `owned` the connection's window → tab
 * pairs, including windows a tab has only reserved (Tabby connects a tab only
 * when it is first shown, so restored and adopted background tabs hold their
 * window by reservation until then); `written` the value each window last had
 * in tmux, as far as tomux knows. Each window of a tab in the bar gets that
 * tab's position among this connection's tabs (0 is leftmost); windows whose
 * tab is not in the bar (another Tabby window) are left alone. A window listed
 * twice counts once, with its first owner. Returns nothing when every value
 * matches, and otherwise every window's value: `written` only knows this Tabby
 * window's own writes, so a value it believes correct may have been changed by
 * another Tabby window, and writing only the differences could leave a mix of
 * both orders with ties (change record-order-other-windows, design D2).
 */
export function planOrderWrites (
    barTabs: readonly object[],
    owned: Iterable<readonly [string, object]>,
    written: ReadonlyMap<string, number>,
): [string, number][] {
    const position = new Map<object, number>()
    barTabs.forEach((tab, i) => {
        if (!position.has(tab)) {
            position.set(tab, i)
        }
    })
    const inBar: [string, number][] = []
    const seen = new Set<string>()
    for (const [windowId, owner] of owned) {
        if (seen.has(windowId)) {
            continue
        }
        seen.add(windowId)
        const at = position.get(owner)
        if (at !== undefined) {
            inBar.push([windowId, at])
        }
    }
    inBar.sort((a, b) => a[1] - b[1])
    const writes = inBar.map(([windowId], order): [string, number] => [windowId, order])
    return writes.some(([windowId, order]) => written.get(windowId) !== order) ? writes : []
}
