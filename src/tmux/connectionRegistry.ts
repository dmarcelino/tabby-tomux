// SPDX-License-Identifier: GPL-3.0-only

/**
 * ConnectionRegistry: at most one TomuxConnection per key (SSH host + tmux
 * session), shared by every tab of that session (design D4). Plain class; an
 * Angular service wraps it.
 *
 * Contract for callers: every `acquire()` that resolves is balanced by exactly
 * one `releaseRef()` with the same key, whichever connection it returned. A
 * rejected `acquire()` holds no reference.
 *
 * The registry never kills anything: idle connections and connections that
 * fail their health check are detached.
 *
 * Contract for tabs: a connection that fails its health check on reuse is
 * replaced, and the old one is detached, so it ends in 'released' while tabs
 * may still be bound to it. Only the registry's idle detach (no references
 * left) releases a connection on purpose, so a tab that sees 'released' on a
 * connection it still holds must treat it like 'lost': show the tab as
 * disconnected and reconnect (acquire again), never close it as if the
 * session had ended.
 *
 * The health check (TomuxConnection.ping) counts a connection as alive while
 * bytes keep arriving, so a connection busy with a large paste or streaming
 * output is not replaced; it fails after `pingTimeoutMs` of silence, or after
 * 60 s at most.
 */

import type { TomuxConnection } from './connection'

/** The SSH profile fields Tabby's SSHMultiplexerService builds its key from. */
export interface ConnectionKeyProfile {
    options: {
        host: string
        port?: number
        user: string
        proxyCommand?: string
        socksProxyHost?: string
        socksProxyPort?: number
        httpProxyHost?: string
        httpProxyPort?: number
        jumpHost?: string
    }
}

/**
 * Registry key for a tmux session over an SSH profile: the fields
 * `SSHMultiplexerService.getMultiplexerKey` uses (host, port, user and the
 * proxy settings), plus the jump host and the session name.
 *
 * Tabby resolves `jumpHost` (a profile id) recursively into that profile's own
 * key; here the id itself is used, so two different jump profiles for the same
 * jump host give two keys (and two connections). Port defaults to 22, as in
 * Tabby's profile defaults.
 */
export function connectionKey (profile: ConnectionKeyProfile, sessionName: string): string {
    const o = profile.options
    return JSON.stringify([
        o.host,
        o.port ?? 22,
        o.user,
        o.proxyCommand ?? null,
        o.socksProxyHost ?? null,
        o.socksProxyPort ?? null,
        o.httpProxyHost ?? null,
        o.httpProxyPort ?? null,
        o.jumpHost ?? null,
        sessionName,
    ])
}

export interface ConnectionRegistryOptions {
    /** Delay between the last releaseRef() and detach. Default 3000 ms. */
    idleDelayMs?: number
    /** Health-check timeout before reusing a connection. Default 5000 ms. */
    pingTimeoutMs?: number
}

interface Entry {
    refs: number
    connection: TomuxConnection | null
    /** The acquisition in flight (connect, or ping-then-maybe-reconnect). */
    pending: Promise<TomuxConnection> | null
    idleTimer: ReturnType<typeof setTimeout> | null
}

export class ConnectionRegistry {
    private readonly entries = new Map<string, Entry>()
    private readonly idleDelayMs: number
    private readonly pingTimeoutMs: number

    constructor (opts: ConnectionRegistryOptions = {}) {
        this.idleDelayMs = opts.idleDelayMs ?? 3_000
        this.pingTimeoutMs = opts.pingTimeoutMs ?? 5_000
    }

    /**
     * Get the connection for `key`, creating it with `factory` if needed.
     *
     * Concurrent callers share one attempt (tmux-integrated race fix #1). An
     * existing connection is pinged first and replaced if it does not answer
     * or has ended. Takes one reference.
     */
    async acquire (key: string, factory: () => Promise<TomuxConnection>): Promise<TomuxConnection> {
        const entry = this.entryFor(key)
        entry.refs++
        this.cancelIdle(entry)

        if (!entry.pending) {
            const pending = this.obtain(key, entry, factory)
            entry.pending = pending
            const clear = (): void => {
                if (entry.pending === pending) {
                    entry.pending = null
                }
            }
            pending.then(clear, clear)
        }

        try {
            return await entry.pending
        } catch (error) {
            this.releaseEntry(key, entry)
            throw error
        }
    }

    /** Drop one reference. At zero, the connection is detached after the idle delay. */
    releaseRef (key: string): void {
        const entry = this.entries.get(key)
        if (entry) {
            this.releaseEntry(key, entry)
        }
    }

    private releaseEntry (key: string, entry: Entry): void {
        if (this.entries.get(key) !== entry || entry.refs === 0) {
            return
        }
        entry.refs--
        if (entry.refs > 0 || entry.pending) {
            return
        }
        const connection = entry.connection
        if (!connection) {
            this.entries.delete(key)
            return
        }
        this.cancelIdle(entry)
        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null
            if (entry.refs > 0 || entry.connection !== connection) {
                return
            }
            this.forget(key, entry, connection)
            void connection.detach()
        }, this.idleDelayMs)
    }

    /** The live connection for `key`, if any (no health check, no reference). */
    peek (key: string): TomuxConnection | undefined {
        const connection = this.entries.get(key)?.connection
        return connection?.isLive ? connection : undefined
    }

    /** Current reference count for `key` (for diagnostics and tests). */
    refCount (key: string): number {
        return this.entries.get(key)?.refs ?? 0
    }

    private entryFor (key: string): Entry {
        let entry = this.entries.get(key)
        if (!entry) {
            entry = { refs: 0, connection: null, pending: null, idleTimer: null }
            this.entries.set(key, entry)
        }
        return entry
    }

    private async obtain (key: string, entry: Entry, factory: () => Promise<TomuxConnection>): Promise<TomuxConnection> {
        const existing = entry.connection
        if (existing) {
            if (existing.isLive && await existing.ping(this.pingTimeoutMs)) {
                if (existing.isLive) {
                    return existing
                }
            }
            // Stale or ended: drop it. detach() never kills, and on an ended
            // connection it only finishes closing the channel. A live one ends
            // 'released'; its tabs must treat that like 'lost' (see header).
            if (entry.connection === existing) {
                entry.connection = null
            }
            void existing.detach()
        }

        const connection = await factory()
        entry.connection = connection
        void connection.closed.then(() => this.onEnded(key, entry, connection))
        if (!connection.isLive) {
            // Ended between open() and now; the closed handler drops it.
            throw new Error('tmux control connection ended while connecting')
        }
        return connection
    }

    /** A connection reached a terminal state: the next acquire reconnects. */
    private onEnded (key: string, entry: Entry, connection: TomuxConnection): void {
        if (entry.connection !== connection) {
            return
        }
        entry.connection = null
        this.cancelIdle(entry)
        if (entry.refs === 0 && !entry.pending && this.entries.get(key) === entry) {
            this.entries.delete(key)
        }
    }

    private forget (key: string, entry: Entry, connection: TomuxConnection): void {
        if (entry.connection === connection) {
            entry.connection = null
        }
        if (this.entries.get(key) === entry && entry.refs === 0 && !entry.pending) {
            this.entries.delete(key)
        }
    }

    private cancelIdle (entry: Entry): void {
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer)
            entry.idleTimer = null
        }
    }
}
