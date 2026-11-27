// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Tabby session behind a tomux tab: one tmux pane, reached through the
 * shared control connection (design D8). Typing becomes `send-keys` commands
 * (ported encoding), pane `%output` becomes terminal output (ported cleanup).
 */
import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { GateEntry, GateSnapshot, OutputGate } from './outputGate'
import { CLEAR_SCREEN, renderCapture } from './paneRedraw'
import { needsRedraw, PaneRowsKeeper } from './paneRows'
import { paneSwitchMarker } from './tabTitle'
import type { TomuxConnection } from './tmux/connection'
import { CommandFlags, TmuxLayoutChange, TmuxPaneOutput } from './tmux/controlClient'
import { PaneBorderStatus, paneCellInLayout, PaneRows, paneRows } from './tmux/layout'
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
/** How long a new tab waits for tmux to report the pane border status before showing output. */
export const BORDER_STATUS_TIMEOUT_MS = 1500

export class TomuxPaneSession extends BaseSession {
    private normalizer = new PaneOutputNormalizer()
    /** Keeps the tab scrolling within the pane's rows (change short-pane-scroll). */
    private keeper = new PaneRowsKeeper()
    private gate = new OutputGate(entry => this.emitEntry(entry))
    /** The pane's rows as the tab shows them, in the order the gate passes them on; null when unknown. */
    private shownRows: PaneRows | null = null
    /** Read when the session starts; a layout's cells include the status line's row (see `paneRows`). */
    private borderStatus: PaneBorderStatus = 'off'
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
     * Follows the pane's rows. The visible layout shows a zoomed pane at the
     * window's size; a layout without this pane (another window, another pane
     * zoomed) says nothing about it.
     */
    private readonly onLayoutChange = (change: TmuxLayoutChange): void => {
        const cell = paneCellInLayout(change.visibleLayout, Number(this.paneIdValue.slice(1)))
        if (cell) {
            this.gate.pushLayout(cell)
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
        this.connection.gateway.on('layout-change', this.onLayoutChange)
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
     * the history is not appended below what the tab already shows. The
     * window's pane border status is read before any output is shown, so
     * held layout changes give the pane's rows right.
     */
    async start (options?: { adopt?: boolean, redraw?: boolean }): Promise<void> {
        this.open = true
        const borderStatus = this.readBorderStatus()
        if (options?.adopt) {
            const number = ++this.captureNumber
            const [snapshot] = await Promise.all([this.captureSnapshot(this.paneIdValue, number), borderStatus])
            if (number !== this.captureNumber) {
                return
            }
            this.gate.open(snapshot !== null && options.redraw ? { ...snapshot, text: CLEAR_SCREEN + snapshot.text } : snapshot)
        } else {
            await borderStatus
            this.gate.open()
        }
    }

    /**
     * Follow a different pane of the same window (tmux's active pane changed).
     * The redraw starts with `paneSwitchMarker(paneId)`.
     */
    switchPane (paneId: string): void {
        this.paneIdValue = paneId
        // The marker tells the tab's title logic where the new pane's output starts.
        const clear = paneSwitchMarker(paneId) + CLEAR_SCREEN
        // Without a capture, the new pane's rows are unknown.
        this.drawPaneAgain(clear, { text: clear, rows: null })
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

    /**
     * The terminal's resize gave the whole screen back as the scroll region:
     * set the pane's again. The layout change tmux sends next brings the
     * pane's new height.
     */
    resize (columns: number, rows: number): void {
        this.gate.pushReapply()
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

    /**
     * Draws the pane again from a new capture, after `before`. Output is held
     * meanwhile; output older than the capture is in it. Without a capture
     * (it failed), only `withoutCapture` is written.
     */
    private drawPaneAgain (before: string, withoutCapture: GateSnapshot | null): void {
        this.gate.hold()
        const paneId = this.paneIdValue
        const number = ++this.captureNumber
        void this.captureSnapshot(paneId, number).then(snap => {
            if (number !== this.captureNumber) {
                return
            }
            this.gate.open(snap ? { ...snap, text: before + snap.text } : withoutCapture)
        })
    }

    /**
     * The window's `pane-border-status`, or 'off' when tmux doesn't answer in
     * time. A change of the option later is not followed.
     */
    private async readBorderStatus (): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<PaneBorderStatus>(resolve => {
            timer = setTimeout(() => resolve('off'), BORDER_STATUS_TIMEOUT_MS)
        })
        const query = this.connection.client.paneBorderStatus(this.paneIdValue).catch(error => {
            this.logger.debug('Could not read the pane border status:', error)
            return 'off' as const
        })
        try {
            this.borderStatus = await Promise.race([query, timeout])
        } finally {
            clearTimeout(timer)
        }
    }

    private stopListening (): void {
        if (this.listening) {
            this.listening = false
            this.connection.gateway.off('output', this.onOutput)
            this.connection.gateway.off('layout-change', this.onLayoutChange)
        }
    }

    /**
     * The pane's screens, cursor and modes, captured atomically, as terminal
     * output (see `renderCapture`), and the pane's rows then. Capture
     * number `number` drops held output only while it is still the latest
     * capture: output held after a later capture began is newer than that
     * capture.
     */
    private async captureSnapshot (paneId: string, number: number): Promise<GateSnapshot | null> {
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
            return { text: renderCapture(snap), rows: { pane: snap.paneHeight, window: snap.windowHeight } }
        } catch (error) {
            this.logger.warn('Could not capture the pane:', error)
            return null
        }
    }

    /**
     * Writes what the gate passes on, through the pane rows keeper. When the
     * pane's height changes, tmux moves its lines and cursor without any
     * output, so a pane shorter than its window is drawn again (`needsRedraw`).
     */
    private emitEntry (entry: GateEntry): void {
        switch (entry.kind) {
            case 'text':
                this.emitText(this.keeper.process(entry.text))
                break
            case 'redraw':
                this.shownRows = entry.rows
                this.keeper.discardHeld()
                this.emitText(this.keeper.setHeight(entry.rows?.pane ?? 0))
                this.emitText(this.keeper.process(entry.text))
                break
            case 'layout': {
                const before = this.shownRows
                const rows = paneRows(entry.cell, this.borderStatus)
                this.shownRows = rows
                this.emitText(this.keeper.setHeight(rows.pane))
                if (needsRedraw(before, rows)) {
                    this.drawPaneAgain(CLEAR_SCREEN, null)
                }
                break
            }
            case 'reapply':
                this.emitText(this.keeper.reapply())
                break
        }
    }

    private emitText (text: string): void {
        if (text) {
            this.emitOutput(Buffer.from(text, 'utf-8'))
        }
    }
}
