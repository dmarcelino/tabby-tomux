// SPDX-License-Identifier: GPL-3.0-only

/**
 * TomuxConnection: one tmux control-mode connection to one session on one
 * host (design D4). It owns the control channel, the gateway parsing it, the
 * typed client on top, and the window ownership map (D5).
 *
 * Lifecycle: `open()` → 'open' → exactly one terminal state:
 *   - 'exited'   tmux sent %exit (the session ended, or tmux detached us), or
 *                tmux moved our client to another session without %exit
 *                (`exitReason` 'session-switched', e.g. `detach-on-destroy
 *                off` after the session was destroyed, or `switch-client`);
 *   - 'lost'     the channel closed or hit EOF without %exit, the SSH session
 *                was destroyed, or a write to the channel failed;
 *   - 'released' this side detached (`detach()`), also when the registry
 *                replaced a connection that failed its health check.
 *
 * In every terminal state the gateway is closed: pending commands reject, and
 * commands sent later reject at once with "tmux connection has ended".
 *
 * The connection never sends kill-window or kill-session (D6): killing is the
 * tab's decision, made through `client`.
 */

import { AsyncSubject, Observable, Subject, Subscription } from 'rxjs'
import { CommandFlags, TmuxGateway } from './gateway'
import {
    parseTmuxVersion,
    TmuxControlClient,
    TmuxVersion,
    TmuxWindow,
    versionAtLeast,
} from './controlClient'
import type { ControlChannel, ControlTransport } from './transport'

/** Oldest tmux tomux supports: `refresh-client -C` needs 2.1 (D4). */
export const MIN_TMUX_VERSION: TmuxVersion = { major: 2, minor: 1 }

export type TomuxConnectionEndState = 'exited' | 'lost' | 'released'
export type TomuxConnectionState = 'open' | TomuxConnectionEndState

/** Window-level notifications later code needs. Pane output stays on the gateway. */
export type TomuxConnectionEvent =
    | { type: 'window-add', windowId: string }
    | { type: 'window-close', windowId: string }
    | { type: 'window-renamed', windowId: string, name: string }
    | { type: 'window-pane-changed', windowId: string, paneId: string }
    | { type: 'session-window-changed', sessionId: string, windowId: string }

export interface TomuxConnectionOptions {
    /** How long to wait for control mode to answer after the channel opened. */
    readyTimeoutMs?: number
    /** How long `detach()` waits for tmux to confirm before closing the channel. */
    detachTimeoutMs?: number
}

/** `exitReason` when tmux moved the control client to another session. */
export const SESSION_SWITCHED_REASON = 'session-switched'

const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_DETACH_TIMEOUT_MS = 2_000
const CREATED_FORMAT = 'display-message -p "#{session_created} #{client_created}"'

/** The host's tmux is missing or older than MIN_TMUX_VERSION. */
export class TmuxVersionError extends Error {
    constructor (readonly found: string, readonly required: string) {
        super(`tomux needs tmux ${required} or newer, but the host has ${found}`)
        this.name = 'TmuxVersionError'
    }
}

export class TomuxConnection {
    readonly client: TmuxControlClient
    readonly gateway: TmuxGateway

    /** Windows listed right after attaching. */
    initialWindows: readonly TmuxWindow[] = []
    /** True when this connection's `new-session -A` created the session (see `detectCreatedSession`). */
    createdSession = false
    /** Reason given with %exit, when tmux gave one (e.g. "detached"). */
    exitReason: string | undefined

    /** Resolves once with the terminal state. Never rejects. */
    readonly closed: Promise<TomuxConnectionEndState>

    private readonly events = new Subject<TomuxConnectionEvent>()
    private readonly closedSubject = new AsyncSubject<TomuxConnectionEndState>()
    private readonly owners = new Map<string, object>()
    private readonly subscriptions = new Subscription()
    private readonly encoder = new TextEncoder()
    private _state: TomuxConnectionState = 'open'
    private detaching = false
    private detachPromise: Promise<void> | null = null
    private released = false
    private channelClosed = false
    private channelClosePromise: Promise<void> | null = null
    private writeChain: Promise<void> = Promise.resolve()
    /** Id ($N) of the session from the first %session-changed (the handshake). */
    private sessionId: string | null = null
    /** Date.now() of the last bytes received from the channel (ping liveness). */
    private lastDataAt = 0

    /**
     * Connect to `sessionName`, creating it if needed.
     *
     * Holds the transport for the connection's lifetime, checks `tmux -V`
     * against MIN_TMUX_VERSION before opening anything, opens the control
     * channel, waits for control mode, then lists the windows. Does not send
     * `refresh-client -C`; call `client.refreshClient()` when a size is known.
     *
     * On failure nothing stays open and the transport is released.
     */
    static async open (
        transport: ControlTransport,
        sessionName: string,
        opts: TomuxConnectionOptions = {},
    ): Promise<TomuxConnection> {
        transport.hold()
        let connection: TomuxConnection | null = null
        let channel: ControlChannel | null = null
        try {
            const version = await checkTmuxVersion(transport)
            channel = await transport.openControlChannel(sessionName)
            connection = new TomuxConnection(transport, channel, sessionName, version, opts)
            await connection.init(opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
            return connection
        } catch (error) {
            if (connection) {
                connection.finish('lost')
            } else {
                if (channel) {
                    await channel.close().catch(() => undefined)
                }
                transport.release()
            }
            throw error
        }
    }

    private constructor (
        private readonly transport: ControlTransport,
        private readonly channel: ControlChannel,
        readonly sessionName: string,
        /** Output of `tmux -V`, trimmed (e.g. "tmux 3.5a"). */
        readonly tmuxVersion: string,
        private readonly opts: TomuxConnectionOptions,
    ) {
        this.closed = new Promise(resolve => {
            this.closedSubject.subscribe(resolve)
        })
        this.gateway = new TmuxGateway(data => this.write(data))
        this.client = new TmuxControlClient(this.gateway)
        this.client.setVersion(tmuxVersion)
        this.wireGateway()

        this.subscriptions.add(channel.data$.subscribe(bytes => {
            if (this._state === 'open') {
                this.lastDataAt = Date.now()
                this.gateway.ingest(bytes)
            }
        }))
        this.subscriptions.add(channel.eof$.subscribe(() => this.finish('lost')))
        this.subscriptions.add(channel.closed$.subscribe(() => {
            this.channelClosed = true
            this.finish('lost')
        }))
        this.subscriptions.add(transport.sessionLost$.subscribe(() => this.finish('lost')))
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    get state (): TomuxConnectionState {
        return this._state
    }

    /** True until the connection reaches a terminal state. */
    get isLive (): boolean {
        return this._state === 'open'
    }

    /** Emits the terminal state once, then completes (replayed to late subscribers). */
    get closed$ (): Observable<TomuxConnectionEndState> {
        return this.closedSubject.asObservable()
    }

    /** Window notifications. Completes when the connection ends. */
    get events$ (): Observable<TomuxConnectionEvent> {
        return this.events.asObservable()
    }

    /**
     * True when tmux answers a probe; false otherwise. Never rejects.
     *
     * The connection counts as alive while bytes keep arriving: tmux answers
     * in order, so a probe behind a backlog (a large paste, streaming output)
     * is late, not lost. Resolves false only after `timeoutMs` with no bytes at
     * all from the channel, or after `maxWaitMs` (default 60 s) in any case.
     */
    async ping (timeoutMs = 5_000, maxWaitMs?: number): Promise<boolean> {
        if (!this.isLive) {
            return false
        }
        return this.client.ping(timeoutMs, { lastActivityAt: () => this.lastDataAt, maxWaitMs })
    }

    // -----------------------------------------------------------------------
    // Window ownership (D5): no two tabs on one window
    // -----------------------------------------------------------------------

    /** Make `owner` the owner of `windowId`. False if someone else owns it. */
    claim (windowId: string, owner: object): boolean {
        const current = this.owners.get(windowId)
        if (current !== undefined && current !== owner) {
            return false
        }
        this.owners.set(windowId, owner)
        return true
    }

    /** Give up `windowId` if `owner` owns it; otherwise do nothing. */
    release (windowId: string, owner: object): void {
        if (this.owners.get(windowId) === owner) {
            this.owners.delete(windowId)
        }
    }

    ownerOf (windowId: string): object | undefined {
        return this.owners.get(windowId)
    }

    /** Every owned window with its owner (a snapshot), for recording the tab order. */
    ownedWindows (): [string, object][] {
        return [...this.owners]
    }

    // -----------------------------------------------------------------------
    // Detach
    // -----------------------------------------------------------------------

    /**
     * Stop using the connection without killing anything: send
     * `detach-client` (errors tolerated), wait up to `detachTimeoutMs` for tmux
     * to end the stream, then close the channel and release the transport.
     * The terminal state becomes 'released'. Idempotent. On a connection that
     * already ended it only waits for the channel to close and keeps the
     * existing terminal state.
     */
    detach (): Promise<void> {
        if (!this.detachPromise) {
            this.detachPromise = this.runDetach()
        }
        return this.detachPromise
    }

    private async runDetach (): Promise<void> {
        if (this._state === 'open') {
            this.detaching = true
            this.client.sendCommand('detach-client', CommandFlags.TolerateErrors).catch(() => undefined)
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([
                this.closed,
                new Promise<void>(resolve => {
                    timer = setTimeout(resolve, this.opts.detachTimeoutMs ?? DEFAULT_DETACH_TIMEOUT_MS)
                }),
            ])
            clearTimeout(timer)
            this.finish('released')
        }
        await this.channelClosePromise
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private async init (readyTimeoutMs: number): Promise<void> {
        const ended = this.closed.then(state => {
            throw new Error(`tmux control connection ended while connecting (${state}${this.exitReason ? `: ${this.exitReason}` : ''})`)
        })
        // Keep an unobserved rejection from surfacing when init succeeds.
        ended.catch(() => undefined)

        await Promise.race([this.client.awaitReady(readyTimeoutMs), ended])
        const [created, windows] = await Promise.race([
            Promise.all([
                this.client.sendCommand(CREATED_FORMAT, CommandFlags.TolerateErrors),
                this.client.listWindows(),
            ]),
            ended,
        ])
        this.createdSession = detectCreatedSession(created[0])
        this.initialWindows = windows
    }

    private wireGateway (): void {
        const gw = this.gateway
        gw.on('tmux-exit', reason => {
            this.exitReason = reason
            this.finish('exited')
        })
        gw.on('session-changed', rest => {
            // "$id name": tmux attached us to `rest`. The first one is the
            // handshake; a later one for another session means tmux moved the
            // client away (no %exit comes), so this connection is over.
            const id = rest.split(' ')[0]
            if (this.sessionId === null) {
                this.sessionId = id
            } else if (id !== this.sessionId) {
                this.exitReason = SESSION_SWITCHED_REASON
                this.finish('exited')
            }
        })
        gw.on('window-add', windowId => this.emit({ type: 'window-add', windowId }))
        gw.on('window-close', windowId => {
            // Ownership goes first, so listeners already see the window as free.
            this.owners.delete(windowId)
            this.emit({ type: 'window-close', windowId })
        })
        gw.on('window-renamed', change => {
            if (change) {
                this.emit({ type: 'window-renamed', windowId: change.windowId, name: change.name })
            }
        })
        gw.on('window-pane-changed', change => {
            this.emit({ type: 'window-pane-changed', windowId: change.windowId, paneId: change.paneId })
        })
        gw.on('session-window-changed', change => {
            if (change) {
                this.emit({ type: 'session-window-changed', sessionId: change.sessionId, windowId: change.windowId })
            }
        })
    }

    private emit (event: TomuxConnectionEvent): void {
        if (this._state === 'open') {
            this.events.next(event)
        }
    }

    /** Writes go out one at a time, in the order the gateway made them. */
    private write (data: string): void {
        if (this._state !== 'open') {
            return
        }
        const bytes = this.encoder.encode(data)
        this.writeChain = this.writeChain
            .then(() => this.channel.write(bytes))
            .catch(() => this.finish('lost'))
    }

    /** Enter a terminal state (first call wins), then tear everything down once. */
    private finish (state: TomuxConnectionEndState): void {
        if (this._state !== 'open') {
            return
        }
        const final = this.detaching ? 'released' : state
        this._state = final
        this.subscriptions.unsubscribe()
        // Rejects pending commands and makes later ones reject at once.
        this.gateway.close()
        this.events.complete()

        this.channelClosePromise = this.channelClosed
            ? Promise.resolve()
            : this.channel.close().catch(() => undefined)
        if (!this.released) {
            this.released = true
            this.transport.release()
        }

        this.closedSubject.next(final)
        this.closedSubject.complete()
    }
}

/**
 * Run `tmux -V` and check it against MIN_TMUX_VERSION. Returns the trimmed
 * version string. Output that does not start with "tmux " means tmux is not
 * installed. A version string without major.minor (e.g. "tmux master", a
 * development build) is accepted.
 */
async function checkTmuxVersion (transport: ControlTransport): Promise<string> {
    const required = `${MIN_TMUX_VERSION.major}.${MIN_TMUX_VERSION.minor}`
    let output: string
    try {
        output = (await transport.readTmuxVersion()).trim()
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new TmuxVersionError(`no usable tmux (tmux -V failed: ${detail})`, required)
    }
    const firstLine = output.split(/\r?\n/u)[0]?.trim() ?? ''
    if (!/^tmux\s/u.test(firstLine)) {
        throw new TmuxVersionError(`no tmux (tmux -V printed: ${JSON.stringify(output)})`, required)
    }
    const parsed = parseTmuxVersion(firstLine)
    if (parsed && !versionAtLeast(parsed, MIN_TMUX_VERSION.major, MIN_TMUX_VERSION.minor)) {
        throw new TmuxVersionError(firstLine, required)
    }
    return firstLine
}

/**
 * Decide whether our `new-session -A` created the session, from the reply to
 * `display-message -p "#{session_created} #{client_created}"`.
 *
 * Rule: created ⇔ session_created ≥ client_created. Both are read from the
 * tmux server's clock (no local/remote clock skew), in whole seconds. tmux
 * creates our control client when the connection is accepted, before it runs
 * `new-session -A`, so a session that command created can never be older
 * than our client, while a session that already existed was created before
 * our client, or in the same second. That same-second case is the only
 * misreading (an existing session created within the second before we
 * attached is reported as created), and it is harmless: such a session is as
 * fresh as one we made. An unparseable reply yields false (existing), which
 * makes tab binding fall back to the lowest-index unclaimed window (D5).
 */
export function detectCreatedSession (reply: string | undefined): boolean {
    const [sessionCreated, clientCreated] = (reply ?? '').trim().split(/\s+/u).map(s => Number.parseInt(s, 10))
    if (!Number.isFinite(sessionCreated) || !Number.isFinite(clientCreated)) {
        return false
    }
    return sessionCreated >= clientCreated
}
