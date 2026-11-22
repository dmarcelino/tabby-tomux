// SPDX-License-Identifier: GPL-3.0-only
import type { TomuxConnection } from './tmux/connection'
import type { ConnectionRegistry } from './tmux/connectionRegistry'

/**
 * Acquires a shared connection and reports whether THIS call opened it.
 * Concurrent callers share one attempt, so exactly one of them sees
 * `opened: true`; callers that find an existing connection see false.
 * Only the opener may take an existing window for a `new` tab (review item 14).
 */
export async function acquireTracked (
    registry: Pick<ConnectionRegistry, 'acquire'>,
    key: string,
    open: () => Promise<TomuxConnection>,
): Promise<{ conn: TomuxConnection, opened: boolean }> {
    let opened = false
    const conn = await registry.acquire(key, () => {
        opened = true
        return open()
    })
    return { conn, opened }
}
