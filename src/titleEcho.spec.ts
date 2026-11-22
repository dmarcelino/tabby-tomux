// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { TabTitleSync } from './tmux/windowTitle'
import { shouldShowRename } from './titleEcho'

function shown (sync: TabTitleSync, name: string): boolean {
    const show = shouldShowRename(sync, name)
    if (show) {
        sync.recordEmission(name)
    }
    return show
}

describe('shouldShowRename', () => {
    it('shows renames made in tmux', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:0')
        expect(shown(sync, 'logs')).toBe(true)
    })

    it('ignores the echo of our own rename', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('api')
        sync.recordRenameSentToTmux('api')
        expect(shown(sync, 'api')).toBe(false)
    })

    it('shows our last rename again when a tmux rename landed in between (review item 15)', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('api')
        sync.recordRenameSentToTmux('api')
        expect(shown(sync, 'logs')).toBe(true)   // tmux-side rename arrives first
        expect(shown(sync, 'api')).toBe(true)    // then the echo of ours: tmux's final name
        expect(sync.lastEmittedTitle).toBe('api')
    })

    it('never flickers back through an older name of ours', () => {
        const sync = new TabTitleSync()
        sync.recordRenameSentToTmux('a')
        sync.recordRenameSentToTmux('b')
        sync.recordEmission('b')
        expect(shown(sync, 'a')).toBe(false)     // superseded by our newer rename
        expect(shown(sync, 'b')).toBe(false)
        expect(sync.lastEmittedTitle).toBe('b')
    })
})
