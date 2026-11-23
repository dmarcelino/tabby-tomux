// SPDX-License-Identifier: GPL-3.0-only
/**
 * ControlTransport over Tabby's own SSH connection (design D2/D4, spike 1):
 * tmux runs on its own exec channel of the SSHSession that Tabby authenticated,
 * so no shell, prompt or banner ever reaches the control-mode parser.
 */
import { Observable, Subscription } from 'rxjs'
import type { ControlChannel, ControlTransport } from './tmux/transport'
import { shellescape } from './tmux/controlClient'

/** The parts of a russh Channel tomux uses (verified in spike 1, russh 0.1.38). */
interface RusshChannel {
    readonly data$: Observable<Uint8Array>
    /** stderr and other extended data, as [type, data]. */
    readonly extendedData$: Observable<[number, Uint8Array]>
    readonly eof$: Observable<void>
    readonly closed$: Observable<void>
    requestPTY (terminal: string, opts: { columns: number, rows: number, pixWidth: number, pixHeight: number }): Promise<void>
    requestExec (command: string): Promise<void>
    write (data: Uint8Array): Promise<void>
    close (): Promise<void>
}

interface RusshAuthenticatedClient {
    openSessionChannel (): Promise<unknown>
    activateChannel (ch: unknown): Promise<RusshChannel>
}

/** The parts of tabby-ssh's SSHSession tomux uses (see tabbyAdapter.ts). */
export interface SshSessionLike {
    ssh: unknown
    willDestroy$: Observable<void>
    ref (): void
    unref (): void
}

const VERSION_TIMEOUT_MS = 10_000

export class SshControlTransport implements ControlTransport {
    readonly sessionLost$: Observable<void>

    constructor (private session: SshSessionLike, private terminalType = 'xterm-256color') {
        this.sessionLost$ = session.willDestroy$
    }

    hold (): void {
        this.session.ref()
    }

    release (): void {
        this.session.unref()
    }

    async openControlChannel (sessionName: string): Promise<ControlChannel> {
        const ch = await this.openChannel()
        try {
            // tmux -CC needs a terminal; its size is set later with refresh-client -C.
            await ch.requestPTY(this.terminalType, { columns: 80, rows: 24, pixWidth: 0, pixHeight: 0 })
            await ch.requestExec(`tmux -CC new-session -A -s ${shellescape(sessionName)}`)
        } catch (error) {
            // The caller never sees the channel, so nobody else would close it.
            await closeQuietly(ch)
            throw error
        }
        return ch
    }

    async readTmuxVersion (): Promise<string> {
        const ch = await this.openChannel()
        const chunks: Uint8Array[] = []
        const errChunks: Uint8Array[] = []
        let gotEof = false
        const subscriptions = new Subscription()
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('tmux -V did not answer in time')), VERSION_TIMEOUT_MS)
            subscriptions.add(ch.data$.subscribe(d => chunks.push(d)))
            subscriptions.add(ch.extendedData$.subscribe(([, d]) => errChunks.push(d)))
            subscriptions.add(ch.eof$.subscribe(() => { gotEof = true }))
            subscriptions.add(ch.closed$.subscribe(() => resolve()))
        })
        // `done` is awaited only after requestExec succeeds; never let it
        // reject unobserved when requestExec fails first.
        done.catch(() => undefined)
        let started = 0
        try {
            started = Date.now()
            // `2>&1` so that "tmux: command not found" reaches the caller's error message.
            await ch.requestExec('tmux -V 2>&1')
            await done
        } finally {
            clearTimeout(timer)
            subscriptions.unsubscribe()
            void closeQuietly(ch)
        }
        const output = decode(chunks)
        if (!output) {
            // Output from the remote shell itself (not tmux) only reaches stderr.
            throw new Error(`no output; stderr: ${JSON.stringify(decode(errChunks))}; ` +
                `EOF: ${gotEof ? 'yes' : 'no'}; channel closed after ${Date.now() - started} ms`)
        }
        return output
    }

    private async openChannel (): Promise<RusshChannel> {
        const client = this.session.ssh as RusshAuthenticatedClient
        if (typeof client?.openSessionChannel !== 'function') {
            throw new Error('The SSH connection is not logged in')
        }
        return client.activateChannel(await client.openSessionChannel())
    }
}

function decode (chunks: Uint8Array[]): string {
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8').trim()
}

/** Close a channel, ignoring any error (it may already be closed). */
async function closeQuietly (ch: RusshChannel): Promise<void> {
    try {
        await ch.close()
    } catch {
        // Already closed or the session is gone: nothing left to release.
    }
}
