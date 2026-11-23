// SPDX-License-Identifier: GPL-3.0-only
/**
 * Runs one piece of async work at a time: a call made while the work is
 * still running joins it instead of starting a second copy.
 *
 * A tomux tab uses this for its connect flow (change add-ssh-toolbar). The
 * toolbar's Reconnect can be double-clicked or clicked during a slow login,
 * and Tabby's "reconnect on session end" calls reconnect() from inside
 * reconnect(). Two concurrent connects would each take a connection
 * reference and only one would be given back, so tmux's control client
 * would never detach.
 */
export class SingleFlight {
    private current: Promise<void> | null = null

    /** True while work is running. */
    get running (): boolean {
        return this.current !== null
    }

    run (work: () => Promise<void>): Promise<void> {
        if (!this.current) {
            // `current` is set before the work starts (on the next microtask),
            // so a call the work itself makes joins this run.
            this.current = Promise.resolve().then(work).finally(() => {
                this.current = null
            })
        }
        return this.current
    }
}
