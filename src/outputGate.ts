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
 */
export class OutputGate {
    private held: string[] | null = []

    constructor (private emit: (data: string) => void) { }

    get isHolding (): boolean {
        return this.held !== null
    }

    push (data: string): void {
        if (this.held) {
            this.held.push(data)
        } else {
            this.emit(data)
        }
    }

    /** Called synchronously when tmux starts the capture: older output is in it. */
    captureStarted (): void {
        if (this.held) {
            this.held = []
        }
    }

    /** Shows `snapshot` (if any), then everything held, then passes output straight through. */
    open (snapshot?: string | null): void {
        const held = this.held ?? []
        this.held = null
        if (snapshot) {
            this.emit(snapshot)
        }
        for (const data of held) {
            this.emit(data)
        }
    }

    /** Starts holding again (the window's active pane changed). */
    hold (): void {
        if (!this.held) {
            this.held = []
        }
    }
}
