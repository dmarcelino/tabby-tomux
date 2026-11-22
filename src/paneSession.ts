// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Tabby session behind a tomux tab: one tmux pane, reached through the
 * shared control connection (design D8). Typing becomes `send-keys` commands
 * (ported encoding), pane `%output` becomes terminal output (ported cleanup).
 */
import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { OutputGate } from './outputGate'
import type { TomuxConnection } from './tmux/connection'
import { CommandFlags, TmuxPaneOutput } from './tmux/controlClient'
import { PaneOutputNormalizer } from './tmux/paneOutput'
import { dropTerminalReplies, encodeSendKeys } from './tmux/sendKeys'

/** Upper bound on one batched line of send-keys commands written to tmux. */
const MAX_BATCH_LINE = 8192

export class TomuxPaneSession extends BaseSession {
    private normalizer = new PaneOutputNormalizer()
    private gate = new OutputGate(text => this.emitText(text))
    private listening = false
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
     */
    async start (options?: { adopt?: boolean }): Promise<void> {
        this.open = true
        if (options?.adopt) {
            this.gate.open(await this.captureSnapshot(this.paneIdValue))
        } else {
            this.gate.open()
        }
    }

    /** Follow a different pane of the same window (tmux's active pane changed). */
    switchPane (paneId: string): void {
        this.gate.hold()
        this.paneIdValue = paneId
        void this.captureSnapshot(paneId).then(snap => {
            this.gate.open('\x1b[2J\x1b[3J\x1b[H' + (snap ?? ''))
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

    supportsWorkingDirectory (): boolean {
        return false
    }

    async getWorkingDirectory (): Promise<string | null> {
        return null
    }

    private stopListening (): void {
        if (this.listening) {
            this.listening = false
            this.connection.gateway.off('output', this.onOutput)
        }
    }

    /** History + screen + cursor, captured atomically together (one tmux line). */
    private async captureSnapshot (paneId: string): Promise<string | null> {
        try {
            const snap = await this.connection.client.captureWithCursor(paneId, {
                onCaptureStart: () => this.gate.captureStarted(),
            })
            return snap.text.replace(/\n/g, '\r\n') + `\x1b[${snap.cursorY + 1};${snap.cursorX + 1}H`
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
