// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Tabby session behind a tomux tab: one tmux pane, reached through the
 * shared control connection (design D8). Typing becomes `send-keys` commands
 * (ported encoding), pane `%output` becomes terminal output (ported cleanup).
 */
import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { OutputGate } from './outputGate'
import { CLEAR_SCREEN, renderCapture } from './paneRedraw'
import { paneSwitchMarker } from './tabTitle'
import type { TomuxConnection } from './tmux/connection'
import { CommandFlags, TmuxPaneOutput } from './tmux/controlClient'
import { PaneOutputNormalizer } from './tmux/paneOutput'
import { dropTerminalReplies, encodeSendKeys } from './tmux/sendKeys'

/** Upper bound on one batched line of send-keys commands written to tmux. */
const MAX_BATCH_LINE = 8192
/**
 * How long to wait for tmux to report the pane's directory. Tabby awaits it
 * before opening the SFTP panel, and the reply can queue behind a large
 * paste or never come on a stalled connection.
 */
export const WORKING_DIRECTORY_TIMEOUT_MS = 1500

export class TomuxPaneSession extends BaseSession {
    private normalizer = new PaneOutputNormalizer()
    private gate = new OutputGate(text => this.emitText(text))
    private listening = false
    /**
     * Number of the latest capture. Only the latest is drawn: a pane in the
     * alternate screen takes two tmux lines to capture, so an earlier pane's
     * capture can arrive after a later one's.
     */
    private captureNumber = 0
    private readonly onOutput = (out: TmuxPaneOutput): void => {
        if (out.paneId === this.paneIdValue) {
            this.gate.push(this.normalizer.normalize(out.data))
        }
    }

    /**
     * Starts listening (and holding) at once, so output printed while the tab
     * is still being set up, such as a new shell's first prompt, is kept.
     */
    constructor (
        logger: Logger,
        private connection: TomuxConnection,
        private paneIdValue: string,
        private onResize: (columns: number, rows: number) => void,
    ) {
        super(logger)
        this.connection.gateway.on('output', this.onOutput)
        this.listening = true
    }

    get paneId (): string {
        return this.paneIdValue
    }

    /**
     * Starts the session. For a window that existed before (`adopt`), its
     * history and screen are shown first; output already contained in that
     * capture is dropped and newer output follows it (review item 13).
     * `redraw` (a reconnecting tab) clears the screen and scrollback first, so
     * the history is not appended below what the tab already shows.
     */
    async start (options?: { adopt?: boolean, redraw?: boolean }): Promise<void> {
        this.open = true
        if (options?.adopt) {
            const number = ++this.captureNumber
            const snapshot = await this.captureSnapshot(this.paneIdValue, number)
            if (number !== this.captureNumber) {
                return
            }
            this.gate.open(snapshot !== null && options.redraw ? CLEAR_SCREEN + snapshot : snapshot)
        } else {
            this.gate.open()
        }
    }

    /**
     * Follow a different pane of the same window (tmux's active pane changed).
     * The redraw starts with `paneSwitchMarker(paneId)`.
     */
    switchPane (paneId: string): void {
        this.gate.hold()
        this.paneIdValue = paneId
        const number = ++this.captureNumber
        void this.captureSnapshot(paneId, number).then(snap => {
            if (number !== this.captureNumber) {
                return
            }
            // The marker tells the tab's title logic where the new pane's output starts.
            this.gate.open(paneSwitchMarker(paneId) + CLEAR_SCREEN + (snap ?? ''))
        })
    }

    write (data: Buffer): void {
        if (!this.open) {
            return
        }
        const text = dropTerminalReplies(data.toString('utf-8'))
        if (!text) {
            return
        }
        let commands: string[]
        try {
            commands = encodeSendKeys(text, this.paneIdValue)
        } catch (error) {
            this.logger.warn('Could not encode input for tmux:', error)
            return
        }
        // A large paste becomes tens of thousands of small commands. Send them
        // in bounded batches (one written line each, one reply per command);
        // the gateway keeps them in order. Errors (e.g. pane gone) are tolerated.
        let batch: string[] = []
        let size = 0
        const flush = () => {
            if (batch.length) {
                this.connection.client.sendCommandList(batch, CommandFlags.TolerateErrors).catch(() => null)
                batch = []
                size = 0
            }
        }
        for (const command of commands) {
            if (size + command.length + 3 > MAX_BATCH_LINE) {
                flush()
            }
            batch.push(command)
            size += command.length + 3
        }
        flush()
    }

    resize (columns: number, rows: number): void {
        this.onResize(columns, rows)
    }

    /** Ends the session on the Tabby side only. Never touches tmux. */
    kill (): void {
        if (!this.open) {
            return
        }
        this.open = false
        this.stopListening()
        this.closed.next()
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill()
    }

    async destroy (): Promise<void> {
        this.stopListening()
        await super.destroy()
    }

    /** tmux knows every pane's directory, so no shell setup (OSC 7) is needed. */
    supportsWorkingDirectory (): boolean {
        return this.connection.isLive
    }

    /** The pane's current directory from tmux, or null when it can't be had in time. */
    async getWorkingDirectory (): Promise<string | null> {
        if (!this.connection.isLive) {
            return null
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), WORKING_DIRECTORY_TIMEOUT_MS)
        })
        const query = this.connection.client.paneCurrentPath(this.paneIdValue).catch(error => {
            this.logger.debug('Could not read the pane\'s working directory:', error)
            return null
        })
        try {
            return await Promise.race([query, timeout])
        } finally {
            clearTimeout(timer)
        }
    }

    private stopListening (): void {
        if (this.listening) {
            this.listening = false
            this.connection.gateway.off('output', this.onOutput)
        }
    }

    /**
     * The pane's screens, cursor and modes, captured atomically, as terminal
     * output (see `renderCapture`). Capture number `number` drops held output
     * only while it is still the latest capture: output held after a later
     * capture began is newer than that capture.
     */
    private async captureSnapshot (paneId: string, number: number): Promise<string | null> {
        try {
            const snap = await this.connection.client.captureWithCursor(paneId, {
                onCaptureStart: () => {
                    if (number === this.captureNumber) {
                        this.gate.captureStarted()
                    }
                },
            })
            this.logger.info(`Captured pane ${paneId}: pane ${snap.paneWidth}x${snap.paneHeight}, ` +
                `cursor ${snap.cursorX},${snap.cursorY}, ${snap.text.split('\n').length} lines` +
                (snap.alternate ? ', alternate screen' : ''))
            return renderCapture(snap)
        } catch (error) {
            this.logger.warn('Could not capture the pane:', error)
            return null
        }
    }

    private emitText (text: string): void {
        if (text) {
            this.emitOutput(Buffer.from(text, 'utf-8'))
        }
    }
}
