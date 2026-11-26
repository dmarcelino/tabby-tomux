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
 * The snapshot and the pane's own output leave through different callbacks.
 * The snapshot is history drawn again from tmux, not new output, so the
 * session shows it without passing it through Tabby's session middleware:
 * a plugin such as tabby-trzsz would otherwise react to old text in it
 * (the start line of a finished transfer) as if the pane had just printed it.
 */
export class OutputGate {
    private held: string[] | null = []

    /**
     * @param emitLive   output the pane produced (held or passed through)
     * @param emitReplay the snapshot handed to `open`
     */
    constructor (
        private emitLive: (data: string) => void,
        private emitReplay: (data: string) => void,
    ) { }

    get isHolding (): boolean {
        return this.held !== null
    }

    push (data: string): void {
        if (this.held) {
            this.held.push(data)
        } else {
            this.emitLive(data)
        }
    }

    /** Called synchronously when tmux starts the capture: older output is in it. */
    captureStarted (): void {
        if (this.held) {
            this.held = []
        }
    }

    /**
     * Shows `snapshot` (if any) through the replay output, then everything
     * held, then passes output straight through.
     */
    open (snapshot?: string | null): void {
        const held = this.held ?? []
        this.held = null
        if (snapshot) {
            this.emitReplay(snapshot)
        }
        for (const data of held) {
            this.emitLive(data)
        }
    }

    /** Starts holding again (the window's active pane changed). */
    hold (): void {
        if (!this.held) {
            this.held = []
        }
    }
}
