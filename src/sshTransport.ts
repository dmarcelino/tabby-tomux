// SPDX-License-Identifier: GPL-3.0-only
/**
 * ControlTransport over Tabby's own SSH connection (design D2/D4, spike 1):
 * tmux runs on its own exec channel of the SSHSession that Tabby authenticated,
 * so no shell, prompt or banner ever reaches the control-mode parser.
 */
import { Observable, Subscription } from 'rxjs'
import { TmuxVersionNoOutputError } from './tmux/transport'
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
        let sessionDestroyed = false
        const markDestroyed = (): void => { sessionDestroyed = true }
        // Watch from before the channel opens. SSHSession.destroy() calls
        // next() then complete(), so a destroy that already happened only
        // reaches this subscriber as complete.
        const subscriptions = new Subscription()
        subscriptions.add(this.session.willDestroy$.subscribe({ next: markDestroyed, complete: markDestroyed }))
        // One deadline for opening the channel, the exec request and the reply:
        // any of them can hang on a connection that is going away.
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('tmux -V did not answer in time')), VERSION_TIMEOUT_MS)
        })
        // Awaited only through Promise.race; never let it reject unobserved.
        deadline.catch(() => undefined)
        const chunks: Uint8Array[] = []
        const errChunks: Uint8Array[] = []
        let gotEof = false
        let started = 0
        try {
            const opening = this.openChannel()
            let ch: RusshChannel
            try {
                ch = await Promise.race([opening, deadline])
            } catch (error) {
                // Gave up first: close the channel if it still opens.
                opening.then(late => closeQuietly(late), () => undefined)
                throw error
            }
            try {
                const done = new Promise<void>(resolve => {
                    subscriptions.add(ch.data$.subscribe(d => chunks.push(d)))
                    subscriptions.add(ch.extendedData$.subscribe(([, d]) => errChunks.push(d)))
                    subscriptions.add(ch.eof$.subscribe(() => { gotEof = true }))
                    subscriptions.add(ch.closed$.subscribe(() => resolve()))
                })
                started = Date.now()
                // `2>&1` so that "tmux: command not found" reaches the caller's error message.
                await Promise.race([ch.requestExec('tmux -V 2>&1'), deadline])
                await Promise.race([done, deadline])
            } finally {
                subscriptions.unsubscribe()
                void closeQuietly(ch)
            }
        } finally {
            clearTimeout(timer)
            subscriptions.unsubscribe()
        }
        const output = decode(chunks)
        if (!output) {
            // Output from the remote shell itself (not tmux) only reaches stderr.
            throw new TmuxVersionNoOutputError(`no output; stderr: ${JSON.stringify(decode(errChunks))}; ` +
                `EOF: ${gotEof ? 'yes' : 'no'}; channel closed after ${Date.now() - started} ms; ` +
                `SSH session destroyed: ${sessionDestroyed ? 'yes' : 'no'}`, sessionDestroyed)
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

const sessionNumbers = new WeakMap<object, number>()
let nextSessionNumber = 1

/** A number that tells SSH sessions apart in the log ("SSH session #2"). */
export function sshSessionNumber (session: object): number {
    let n = sessionNumbers.get(session)
    if (n === undefined) {
        n = nextSessionNumber++
        sessionNumbers.set(session, n)
    }
    return n
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
