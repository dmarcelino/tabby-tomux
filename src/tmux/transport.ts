// SPDX-License-Identifier: GPL-3.0-only

/**
 * The boundary between a TomuxConnection and the SSH connection it runs on.
 *
 * Shaped after the russh `Channel` that spike 1 used inside Tabby (design D2),
 * but free of any Tabby or russh import so the connection layer can be unit
 * tested with a fake. The real implementation lives with the Tabby adapter.
 */

import type { Observable } from 'rxjs'

/** One SSH channel carrying the `tmux -CC` control stream. */
export interface ControlChannel {
    /** Bytes from the remote side, in arrival order. */
    readonly data$: Observable<Uint8Array>
    /** The remote side sent EOF (tmux exited, or the channel is going away). */
    readonly eof$: Observable<void>
    /** The channel is closed; no more data will arrive. */
    readonly closed$: Observable<void>
    /** Write bytes to the channel (tmux's stdin). */
    write (data: Uint8Array): Promise<void>
    /** Close the channel. Must be safe to call more than once. */
    close (): Promise<void>
}

/**
 * `tmux -V` closed its channel without printing anything. The message carries
 * the diagnostics (stderr, EOF, channel lifetime, session state).
 */
export class TmuxVersionNoOutputError extends Error {
    constructor (message: string, readonly sessionDestroyed: boolean) {
        super(message)
        this.name = 'TmuxVersionNoOutputError'
    }
}

/** What a TomuxConnection needs from Tabby's SSH session. */
export interface ControlTransport {
    /**
     * Open the control channel: an exec channel with a PTY running
     * `tmux -CC new-session -A -s <sessionName>` (design D2).
     */
    openControlChannel (sessionName: string): Promise<ControlChannel>

    /**
     * Run `tmux -V` on a separate exec channel and return its output, e.g.
     * "tmux 3.5a". Rejects (or returns something that does not start with
     * "tmux ") when tmux is not installed. Rejects with
     * TmuxVersionNoOutputError when the channel closes without any output.
     */
    readTmuxVersion (): Promise<string>

    /** Fires when Tabby's SSH session is destroyed (SSHSession.willDestroy$). */
    readonly sessionLost$: Observable<void>

    /** Keep the SSH session alive while the connection uses it (SSHSession.ref()). */
    hold (): void

    /**
     * Balance one hold() (SSHSession.unref()). The connection calls this
     * exactly once per hold(), also after sessionLost$ fired, so the real
     * implementation must tolerate a release on a destroyed session.
     */
    release (): void
}
