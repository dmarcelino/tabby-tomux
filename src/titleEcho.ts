// SPDX-License-Identifier: GPL-3.0-only
import type { TabTitleSync } from './tmux/windowTitle'

/**
 * Whether a `%window-renamed` should change the tab title.
 *
 * Echoes of renames this tab sent are normally ignored (the tab already shows
 * that name). But when the echo of the LAST rename we sent arrives after a
 * tmux-side rename changed the tab meanwhile, tmux's final name is ours, so
 * the tab must show it again (review item 15). An older echo that a newer
 * rename of ours supersedes stays ignored, so quick successive renames never
 * flicker back through the older name.
 */
export function shouldShowRename (sync: TabTitleSync, name: string): boolean {
    if (!sync.consumeRenameEcho(name)) {
        return true
    }
    return !sync.hasPendingRenames() && sync.lastEmittedTitle !== name.trim()
}
