// SPDX-License-Identifier: GPL-3.0-only
/**
 * Shows and hides the SFTP panel of a tomux tab (change add-ssh-toolbar,
 * design T2). Tabby only ever assigns `sftpPanelVisible` (from `openSFTP()`,
 * `onClick()` and the panel's `closed` output); the tab forwards those
 * assignments here, and this decides whether a panel exists.
 *
 * Kept free of Angular so the rules are unit-testable: the tab supplies
 * `open`, which creates the panel or returns null when it can't yet (no view,
 * no SSH session, or no SFTPPanelComponent in this Tabby).
 */
import type { SftpPanelHandle } from './tabbyAdapter'

export class SftpPanelControl {
    private handle: SftpPanelHandle | null = null

    constructor (private readonly open: () => SftpPanelHandle | null) {}

    /** True while a panel is shown. */
    get visible (): boolean {
        return this.handle !== null
    }

    set (visible: boolean): void {
        if (visible) {
            this.handle ??= this.open()
        } else {
            this.close()
        }
    }

    /** Removes the panel, if any. Safe to call at any time. */
    close (): void {
        const handle = this.handle
        this.handle = null
        handle?.destroy()
    }
}
