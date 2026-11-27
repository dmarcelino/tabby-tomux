// SPDX-License-Identifier: GPL-3.0-only
/**
 * Orders a pane's output around the snapshot taken when a tab binds to a
 * window (review items 3 and 13).
 *
 * The gate starts holding as soon as the tab binds, before any other round
 * trip, so a new window's first prompt is never lost. When adopting an
 * existing window, tmux answers `capture-pane ; display-message` in one go:
 * everything held before the capture's %begin is already inside the capture
 * and is dropped; everything after it is newer than the capture and is
 * replayed after the snapshot (and its cursor position).
 *
 * Changes of the pane's rows travel through the gate with the output
 * (change short-pane-scroll), so held output is shown with the rows tmux
 * had when it sent it.
 */
import type { PaneCell, PaneRows } from './tmux/layout'

/** What the gate passes on, in order. */
export type GateEntry =
    /** Pane output. */
    | { kind: 'text', text: string }
    /** A redraw, and the pane's rows it was taken at (null when unknown: a clear with no capture). */
    | { kind: 'redraw', text: string, rows: PaneRows | null }
    /** The pane's cell in a new layout. */
    | { kind: 'layout', cell: PaneCell }
    /** The terminal lost the pane's scroll region (it was resized): set it again. */
    | { kind: 'reapply' }

/** A redraw and the pane's rows it was taken at (null when unknown: a clear with no capture). */
export interface GateSnapshot {
    text: string
    rows: PaneRows | null
}

export class OutputGate {
    private held: GateEntry[] | null = []

    constructor (private emit: (entry: GateEntry) => void) { }

    get isHolding (): boolean {
        return this.held !== null
    }

    push (text: string): void {
        this.add({ kind: 'text', text })
    }

    pushLayout (cell: PaneCell): void {
        this.add({ kind: 'layout', cell })
    }

    pushReapply (): void {
        this.add({ kind: 'reapply' })
    }

    /** Called synchronously when tmux starts the capture: older output and rows are in it. */
    captureStarted (): void {
        if (this.held) {
            this.held = []
        }
    }

    /**
     * Shows `snapshot` (if any), then everything held, then passes entries
     * straight through. Entries left when `emit` starts holding again (the
     * pane is drawn again) stay held.
     */
    open (snapshot?: GateSnapshot | null): void {
        const held = this.held ?? []
        this.held = null
        const entries: GateEntry[] = snapshot ? [{ kind: 'redraw', text: snapshot.text, rows: snapshot.rows }] : []
        entries.push(...held)
        for (let i = 0; i < entries.length; i++) {
            // `emit` may have started holding again.
            const heldAgain = this.heldEntries()
            if (heldAgain) {
                heldAgain.push(...entries.slice(i))
                return
            }
            this.emit(entries[i])
        }
    }

    /** Starts holding again (the window's active pane changed, or the pane is drawn again). */
    hold (): void {
        if (!this.held) {
            this.held = []
        }
    }

    private heldEntries (): GateEntry[] | null {
        return this.held
    }

    private add (entry: GateEntry): void {
        if (this.held) {
            this.held.push(entry)
        } else {
            this.emit(entry)
        }
    }
}
