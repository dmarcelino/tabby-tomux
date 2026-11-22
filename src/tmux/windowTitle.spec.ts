// SPDX-License-Identifier: GPL-3.0-only
//
// Ported from tmux-integrated test/windowTitle.test.js (all tests) and the
// windowTitle.ts-level scenarios of test/renameSync.test.js at commit 0f92f4a.
// Copyright (C) the tmux-integrated authors
//
// Changes: node:test → vitest; renameSync scenarios replayed directly on TabTitleSync (no TmuxTerminal/VS Code mocks).
import { describe, expect, it } from 'vitest'
import { pickTerminalTabTitle, TabTitleSync, tmuxAutomaticRenameIsOn } from './windowTitle'

describe('windowTitle (from test/windowTitle.test.js)', () => {
    it('tmuxAutomaticRenameIsOn accepts version-dependent truthy values', () => {
        for (const v of ['1', 'on', 'ON', ' yes ', 'true']) {
            expect(tmuxAutomaticRenameIsOn(v), `expected "${v}" to read as on`).toBe(true)
        }
        for (const v of ['0', 'off', '', undefined, 'no']) {
            expect(tmuxAutomaticRenameIsOn(v), `expected "${v}" to read as off`).toBe(false)
        }
    })

    it('pickTerminalTabTitle normalizes automatic names to tmux:<n> by default', () => {
        expect(pickTerminalTabTitle('zsh', 3, true, false)).toBe('tmux:3')
        expect(pickTerminalTabTitle('zsh', undefined, true, false)).toBe('tmux')
    })

    it('pickTerminalTabTitle shows automatic names when showAutomaticRename is on', () => {
        expect(pickTerminalTabTitle('zsh', 3, true, true)).toBe('zsh')
        expect(pickTerminalTabTitle('  vim  ', 3, true, true)).toBe('vim')
        // Empty automatic name still falls back to the index label.
        expect(pickTerminalTabTitle('', 3, true, true)).toBe('tmux:3')
        expect(pickTerminalTabTitle(undefined, undefined, true, true)).toBe('tmux')
    })

    it('pickTerminalTabTitle shows intentional (non-automatic) names verbatim in both modes', () => {
        for (const show of [false, true]) {
            expect(pickTerminalTabTitle('build server', 2, false, show)).toBe('build server')
            expect(pickTerminalTabTitle('', 2, false, show)).toBe('tmux:2')
            expect(pickTerminalTabTitle(undefined, undefined, false, show)).toBe('tmux')
        }
    })

    it('TabTitleSync classifies terminal names against emission history', () => {
        const sync = new TabTitleSync()

        // Before anything is emitted, every name is treated as in-sync (no action).
        sync.noteKnownTitle('tmux:0')
        expect(sync.hasEmitted).toBe(false)
        expect(sync.classifyTerminalName('tmux:0')).toBe('in-sync')
        expect(sync.classifyTerminalName('anything')).toBe('in-sync')

        sync.recordEmission('mywin')
        expect(sync.lastEmittedTitle).toBe('mywin')
        expect(sync.classifyTerminalName('mywin')).toBe('in-sync')
        // The creation name may still be displayed while the host applies
        // the emission — that is not a user rename.
        expect(sync.classifyTerminalName('tmux:0')).toBe('settling')
        // A never-seen name can only come from the user.
        expect(sync.classifyTerminalName('user-picked')).toBe('user-rename')
        // Empty / whitespace names are ignored.
        expect(sync.classifyTerminalName('')).toBe('in-sync')
        expect(sync.classifyTerminalName('   ')).toBe('in-sync')
        expect(sync.classifyTerminalName(undefined)).toBe('in-sync')
    })

    it('TabTitleSync never re-classifies an older emitted title as a user rename', () => {
        // Regression: a tmux-side rename could be reverted when the user typed
        // before the host finished applying the new title, because the (stale)
        // previous title diverged from the last emission and was pushed to tmux.
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:0')
        // ... much later, tmux renames the window ...
        sync.recordEmission('renamed-in-tmux')
        // The tab still shows the old title for a moment.
        expect(sync.classifyTerminalName('tmux:0')).toBe('settling')
    })

    it('TabTitleSync consumes rename echoes exactly once', () => {
        const sync = new TabTitleSync()
        sync.recordRenameSentToTmux('foo')
        expect(sync.consumeRenameEcho('foo')).toBe(true)
        expect(sync.consumeRenameEcho('foo'), 'echo record must be consumed').toBe(false)
        expect(sync.consumeRenameEcho('bar')).toBe(false)
    })

    it('TabTitleSync matches interleaved echoes from successive renames', () => {
        const sync = new TabTitleSync()
        sync.recordRenameSentToTmux('a')
        sync.recordRenameSentToTmux('b')
        // Echoes may be processed in order; both must be recognised.
        expect(sync.consumeRenameEcho('a')).toBe(true)
        expect(sync.consumeRenameEcho('b')).toBe(true)
        expect(sync.consumeRenameEcho('a')).toBe(false)
    })

    it('TabTitleSync expires pending rename echoes after the TTL', () => {
        let clock = 0
        const sync = new TabTitleSync(() => clock)
        sync.recordRenameSentToTmux('foo')
        clock += 60_000
        expect(
            sync.consumeRenameEcho('foo'),
            'a %window-renamed long after our command must be treated as external',
        ).toBe(false)
    })

    it('TabTitleSync bounds its remembered-title history', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('first')
        for (let i = 0; i < 500; i++) {
            sync.recordEmission(`title-${i}`)
        }
        // "first" has been evicted; with the current title unaffected.
        expect(sync.classifyTerminalName('first')).toBe('user-rename')
        expect(sync.classifyTerminalName('title-499')).toBe('in-sync')
        expect(sync.classifyTerminalName('title-498')).toBe('settling')
    })
})

/**
 * The renameSync tests drive TmuxTerminal through VS Code mocks. These replay
 * the parts of those scenarios that are decided by windowTitle.ts: the same
 * TabTitleSync / pickTerminalTabTitle calls TmuxTerminal makes, in the same
 * order, with the same inputs.
 */
describe('windowTitle rename-sync scenarios (from test/renameSync.test.js)', () => {
    /** TmuxTerminal's %window-renamed handling, reduced to its windowTitle.ts calls. */
    function onWindowRenamed(sync: TabTitleSync, name: string, windowIndex: number, show: boolean): string | null {
        if (sync.consumeRenameEcho(name)) {
            return null
        }
        const title = pickTerminalTabTitle(name || undefined, windowIndex, false, show)
        if (title === sync.lastEmittedTitle) {
            return null
        }
        sync.recordEmission(title)
        return title
    }

    it('default mode: the echo of our own normalization does not re-emit', () => {
        const sync = new TabTitleSync()
        sync.noteKnownTitle('tmux:5')
        const label = pickTerminalTabTitle('zsh', 5, true, false)
        expect(label).toBe('tmux:5')
        sync.recordEmission(label)
        sync.recordRenameSentToTmux(label)
        expect(onWindowRenamed(sync, 'tmux:5', 5, false)).toBeNull()
    })

    it('default mode: external tmux renames update the tab', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:5')
        expect(onWindowRenamed(sync, 'deploy', 5, false)).toBe('deploy')
    })

    it('stale tab title is never pushed back to tmux (rename-revert regression)', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:5')
        expect(onWindowRenamed(sync, 'renamed-in-tmux', 5, false)).toBe('renamed-in-tmux')
        // The tab still shows the old title: not a user rename.
        expect(sync.classifyTerminalName('tmux:5')).toBe('settling')
    })

    it('user rename is pushed to tmux once, echo suppressed', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:5')
        expect(sync.classifyTerminalName('user-picked')).toBe('user-rename')
        // syncNameToTmux: record the name the tab already shows, then rename.
        sync.recordEmission('user-picked')
        sync.recordRenameSentToTmux('user-picked')
        expect(onWindowRenamed(sync, 'user-picked', 5, false)).toBeNull()
        // A second probe with the same name does nothing.
        expect(sync.classifyTerminalName('user-picked')).toBe('in-sync')
    })

    it('adoption: the creation name never syncs back', () => {
        const sync = new TabTitleSync()
        sync.noteKnownTitle('tmux:3')
        sync.recordEmission(pickTerminalTabTitle('mywin', 3, false, false))
        expect(sync.lastEmittedTitle).toBe('mywin')
        expect(sync.classifyTerminalName('tmux:3')).toBe('settling')
    })

    it('title re-assertion corrects a lagging tab but leaves a user rename alone', () => {
        const sync = new TabTitleSync()
        sync.noteKnownTitle('tmux:3')
        sync.recordEmission('mywin')
        // reassertTitle fires only for 'settling'.
        expect(sync.classifyTerminalName('tmux:3')).toBe('settling')
        expect(sync.classifyTerminalName('mywin')).toBe('in-sync')
        expect(sync.classifyTerminalName('renamed-by-user')).toBe('user-rename')
    })

    it('rapid successive renames do not flicker through stale echoes', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('tmux:5')
        for (const name of ['first', 'second']) {
            sync.recordRenameSentToTmux(name)
            sync.recordEmission(name)
        }
        // Late echoes arrive in order; neither may re-emit.
        expect(onWindowRenamed(sync, 'first', 5, false)).toBeNull()
        expect(onWindowRenamed(sync, 'second', 5, false)).toBeNull()
        expect(sync.lastEmittedTitle).toBe('second')
    })

    it('showAutomaticRename: tab tracks automatic names; a stale one does not pin the window', () => {
        const sync = new TabTitleSync()
        sync.recordEmission(pickTerminalTabTitle('zsh', 5, true, true))
        expect(sync.lastEmittedTitle).toBe('zsh')
        expect(onWindowRenamed(sync, 'vim', 5, true)).toBe('vim')
        expect(sync.classifyTerminalName('zsh')).toBe('settling')
    })

    it('showAutomaticRename: explicit rename pins; a later automatic name flows through', () => {
        const sync = new TabTitleSync()
        sync.recordEmission('zsh')
        sync.recordRenameSentToTmux('pinned')
        sync.recordEmission('pinned')
        expect(onWindowRenamed(sync, 'pinned', 5, true)).toBeNull()
        // After automatic-rename is turned back on, tmux recomputes the name.
        expect(onWindowRenamed(sync, 'bash', 5, true)).toBe('bash')
    })
})
