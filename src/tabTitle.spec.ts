// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { customTitleAction, isPlaceholderName, paneSwitchMarker, pickDisplayTitle, programTitleFromPane, TabTitleController, TabTitleHost } from './tabTitle'

describe('isPlaceholderName', () => {
    it('matches tmux:<digits> only', () => {
        for (const name of ['tmux:0', 'tmux:12', ' tmux:3 ']) {
            expect(isPlaceholderName(name), name).toBe(true)
        }
        for (const name of ['tmux', 'tmux:', 'tmux:a', 'tmux:1x', 'api', 'my tmux:1', '']) {
            expect(isPlaceholderName(name), name).toBe(false)
        }
    })
})

describe('pickDisplayTitle', () => {
    it('shows a name of the user\'s own over the program title', () => {
        expect(pickDisplayTitle({ windowName: 'api', windowIndex: 2, programTitle: 'fix login bug', dynamicTitles: true })).toBe('api')
    })

    it('shows the program title while the window has the placeholder name', () => {
        expect(pickDisplayTitle({ windowName: 'tmux:2', windowIndex: 2, programTitle: 'fix login bug', dynamicTitles: true })).toBe('fix login bug')
    })

    it('treats a placeholder with a stale index as unnamed', () => {
        expect(pickDisplayTitle({ windowName: 'tmux:7', windowIndex: 2, programTitle: 'fix login bug', dynamicTitles: true })).toBe('fix login bug')
    })

    it('falls back to the placeholder name when the program title is empty', () => {
        for (const programTitle of [null, undefined, '', '   ']) {
            expect(pickDisplayTitle({ windowName: 'tmux:2', windowIndex: 2, programTitle, dynamicTitles: true })).toBe('tmux:2')
        }
    })

    it('shows the placeholder as tmux has it, not a recomputed index', () => {
        expect(pickDisplayTitle({ windowName: 'tmux:7', windowIndex: 2, programTitle: null, dynamicTitles: true })).toBe('tmux:7')
    })

    it('falls back to tmux:<index> when no window name is known', () => {
        expect(pickDisplayTitle({ windowIndex: 4, programTitle: null, dynamicTitles: true })).toBe('tmux:4')
        expect(pickDisplayTitle({ windowName: '  ', windowIndex: 4, dynamicTitles: true })).toBe('tmux:4')
        expect(pickDisplayTitle({ dynamicTitles: true })).toBe('tmux')
    })

    it('ignores the program title when dynamic titles are off', () => {
        expect(pickDisplayTitle({ windowName: 'tmux:2', windowIndex: 2, programTitle: 'fix login bug', dynamicTitles: false })).toBe('tmux:2')
        expect(pickDisplayTitle({ windowName: 'api', windowIndex: 2, programTitle: 'fix login bug', dynamicTitles: false })).toBe('api')
    })

    it('trims both sources', () => {
        expect(pickDisplayTitle({ windowName: ' api ', programTitle: 'x', dynamicTitles: true })).toBe('api')
        expect(pickDisplayTitle({ windowName: 'tmux:1', programTitle: '  build  ', dynamicTitles: true })).toBe('build')
    })
})

describe('programTitleFromPane', () => {
    it('reads the host name as no title (tmux\'s default)', () => {
        expect(programTitleFromPane('testhost', 'testhost')).toBeNull()
        expect(programTitleFromPane('box.local', 'box.local')).toBeNull()
    })

    it('reads an empty title as no title', () => {
        expect(programTitleFromPane('', 'testhost')).toBeNull()
        expect(programTitleFromPane('  ', 'testhost')).toBeNull()
    })

    it('returns a title a program set', () => {
        expect(programTitleFromPane('fix login bug', 'testhost')).toBe('fix login bug')
        expect(programTitleFromPane(' build | test ', 'testhost')).toBe('build | test')
    })

    it('only matches the whole host name', () => {
        expect(programTitleFromPane('testhost: ~/src', 'testhost')).toBe('testhost: ~/src')
    })
})

/** A tab stand-in: records what the controller shows and renames; pane titles answer on demand. */
class FakeTab implements TabTitleHost {
    readonly shown: string[] = []
    readonly renames: string[] = []
    readonly reads: string[] = []
    /** Renames and reads in the order they were sent. */
    readonly log: string[] = []
    dynamic = true
    paneTitles = new Map<string, string | null>()
    private pending: Array<() => void> = []
    /** When true, readProgramTitle waits for release(). */
    hold = false

    showTitle (title: string): void { this.shown.push(title) }
    async renameWindow (name: string): Promise<void> { this.renames.push(name); this.log.push(`rename ${name}`) }
    dynamicTitles (): boolean { return this.dynamic }
    readProgramTitle (paneId: string): Promise<string | null> {
        this.reads.push(paneId)
        this.log.push(`read ${paneId}`)
        const answer = (): string | null => this.paneTitles.get(paneId) ?? null
        if (!this.hold) {
            return Promise.resolve(answer())
        }
        return new Promise(resolve => this.pending.push(() => resolve(answer())))
    }

    release (): void {
        const pending = this.pending
        this.pending = []
        pending.forEach(fn => fn())
    }

    get title (): string | undefined { return this.shown[this.shown.length - 1] }
}

/** A tab attached to an unnamed window @1 (index 2, pane %3), as settleTitle leaves it. */
async function attached (tab = new FakeTab()): Promise<{ tab: FakeTab, titles: TabTitleController }> {
    const titles = new TabTitleController(tab)
    await titles.attach({ index: 2, paneId: '%3', name: 'tmux:2', automaticRename: false })
    return { tab, titles }
}

describe('TabTitleController: program titles', () => {
    it('shows a program title on an unnamed window and sends nothing to tmux', async () => {
        const { tab, titles } = await attached()
        expect(tab.title).toBe('tmux:2')
        titles.onProgramTitle('fix login bug')
        titles.onProgramTitle('a')
        titles.onProgramTitle('b')
        expect(tab.title).toBe('b')
        expect(tab.renames).toEqual([])
    })

    it('returns to the placeholder when the program clears its title', async () => {
        const { tab, titles } = await attached()
        titles.onProgramTitle('fix login bug')
        titles.onProgramTitle('')
        expect(tab.title).toBe('tmux:2')
    })

    it('keeps the user\'s window name over program titles', async () => {
        const tab = new FakeTab()
        const titles = new TabTitleController(tab)
        await titles.attach({ index: 2, paneId: '%3', name: 'api', automaticRename: false })
        titles.onProgramTitle('fix login bug')
        expect(tab.shown).toEqual(['api'])
    })

    it('switches to a tmux rename that lands while a program title shows', async () => {
        const { tab, titles } = await attached()
        titles.onProgramTitle('fix login bug')
        titles.onWindowRenamed('logs')
        expect(tab.title).toBe('logs')
    })

    it('ignores program titles when dynamic titles are off, and reads nothing from tmux', async () => {
        const tab = new FakeTab()
        tab.dynamic = false
        tab.paneTitles.set('%3', 'from tmux')
        const { titles } = await attached(tab)
        titles.onProgramTitle('fix login bug')
        expect(tab.shown).toEqual(['tmux:2'])
        expect(tab.reads).toEqual([])
    })

    it('does not show anything before the first attach', () => {
        const tab = new FakeTab()
        const titles = new TabTitleController(tab)
        titles.onProgramTitle('early')
        expect(tab.shown).toEqual([])
        expect(titles.displayedTitle).toBeNull()
    })
})

describe('TabTitleController: seeding from tmux', () => {
    it('shows the pane\'s title on attach, before anything else', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%3', 'fix login bug')
        await attached(tab)
        expect(tab.shown).toEqual(['fix login bug'])
    })

    it('shows the placeholder when the pane has no program title', async () => {
        const { tab } = await attached()
        expect(tab.shown).toEqual(['tmux:2'])
    })

    it('replaces an old program title on reconnect with what tmux holds now', async () => {
        const { tab, titles } = await attached()
        titles.onProgramTitle('old')
        await titles.attach({ index: 2, paneId: '%3', name: 'tmux:2', automaticRename: false })
        expect(tab.title).toBe('tmux:2')
    })

    it('keeps a program title that arrives while tmux is being read', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%3', 'stale')
        tab.hold = true
        const titles = new TabTitleController(tab)
        const attaching = titles.attach({ index: 2, paneId: '%3', name: 'tmux:2', automaticRename: false })
        titles.onProgramTitle('newer')
        tab.release()
        await attaching
        expect(tab.title).toBe('newer')
    })

    it('takes the new pane\'s title on a pane switch', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%3', 'build')
        tab.paneTitles.set('%4', 'editor')
        const { titles } = await attached(tab)
        expect(tab.title).toBe('build')
        await titles.onPaneChanged('%4', true)
        expect(tab.title).toBe('editor')
    })

    it('shows the placeholder after switching to an untitled pane', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%3', 'build')
        const { titles } = await attached(tab)
        await titles.onPaneChanged('%4', true)
        expect(tab.title).toBe('tmux:2')
    })

    it('applies only the latest of two quick pane switches', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%4', 'first')
        tab.paneTitles.set('%5', 'second')
        const { titles } = await attached(tab)
        tab.hold = true
        const a = titles.onPaneChanged('%4', true)
        const b = titles.onPaneChanged('%5', true)
        tab.release()
        await Promise.all([a, b])
        expect(tab.title).toBe('second')
        expect(tab.shown).not.toContain('first')
    })
})

describe('TabTitleController: renames', () => {
    it('pins an automatic name to tmux:<index> on attach', async () => {
        const tab = new FakeTab()
        const titles = new TabTitleController(tab)
        await titles.attach({ index: 5, paneId: '%1', name: 'zsh', automaticRename: true })
        expect(tab.renames).toEqual(['tmux:5'])
        expect(tab.title).toBe('tmux:5')
        titles.onWindowRenamed('tmux:5') // the echo
        expect(tab.shown).toEqual(['tmux:5'])
    })

    it('pushes a Tabby rename to tmux and ignores its echo', async () => {
        const { tab, titles } = await attached()
        titles.onTabbyRename('api')
        expect(tab.renames).toEqual(['api'])
        expect(tab.title).toBe('api')
        titles.onWindowRenamed('api')
        expect(tab.shown).toEqual(['tmux:2', 'api'])
    })

    it('treats a Tabby rename to the program title it shows as a rename', async () => {
        const { tab, titles } = await attached()
        titles.onProgramTitle('fix login bug')
        titles.onTabbyRename('fix login bug')
        expect(tab.renames).toEqual(['fix login bug'])
        titles.onProgramTitle('something else')
        expect(tab.title).toBe('fix login bug')
    })

    it('renaming back to the placeholder follows the program title again', async () => {
        const { tab, titles } = await attached()
        titles.onTabbyRename('api')
        titles.onProgramTitle('fix login bug')
        expect(tab.title).toBe('api')
        titles.onTabbyRename('tmux:3')
        expect(tab.renames).toEqual(['api', 'tmux:3'])
        expect(tab.title).toBe('fix login bug')
    })

    it('sends nothing for a Tabby rename to the current window name or to nothing', async () => {
        const { tab, titles } = await attached()
        titles.onTabbyRename('tmux:2')
        titles.onTabbyRename('  ')
        expect(tab.renames).toEqual([])
    })

    it('ends on the second of two quick Tabby renames', async () => {
        const { tab, titles } = await attached()
        titles.onTabbyRename('a')
        titles.onTabbyRename('b')
        titles.onWindowRenamed('a') // late echo of the first
        titles.onWindowRenamed('b')
        expect(tab.title).toBe('b')
        expect(tab.shown).toEqual(['tmux:2', 'a', 'b'])
    })
})

/** The title xterm reports when it parses `paneSwitchMarker(paneId)`. */
function markerTitle (paneId: string): string {
    const m = /^\x1b\]2;(.*)\x07$/u.exec(paneSwitchMarker(paneId))
    return m![1]
}

describe('TabTitleController: pane switch boundary', () => {
    it('marker is an OSC 2 title naming the pane', () => {
        expect(paneSwitchMarker('%4')).toBe('\x1b]2;tomux-pane-switch %4\x07')
    })

    it('ignores an old-pane title parsed after the switch, and applies the read', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%3', 'building')
        const { titles } = await attached(tab)
        tab.hold = true
        const switching = titles.onPaneChanged('%4', true)
        titles.onProgramTitle('building…')   // the old pane's output, parsed late
        titles.onProgramTitle(markerTitle('%4'))
        tab.release()
        await switching
        expect(tab.title).toBe('tmux:2')
        expect(tab.shown).not.toContain('building…')
    })

    it('a new-pane title after the marker wins over a slower read', async () => {
        const tab = new FakeTab()
        tab.paneTitles.set('%4', 'stale')
        const { titles } = await attached(tab)
        tab.hold = true
        const switching = titles.onPaneChanged('%4', true)
        titles.onProgramTitle(markerTitle('%4'))
        titles.onProgramTitle('editor')
        tab.release()
        await switching
        expect(tab.title).toBe('editor')
    })

    it('never shows the marker', async () => {
        const { tab, titles } = await attached()
        titles.onProgramTitle(markerTitle('%9'))
        await titles.onPaneChanged('%4', true)
        titles.onProgramTitle(markerTitle('%4'))
        expect(tab.shown.some(t => t.startsWith('tomux-pane-switch'))).toBe(false)
    })

    it('waits for the latest switch\'s marker, not an earlier one', async () => {
        const { tab, titles } = await attached()
        await titles.onPaneChanged('%4', true)
        await titles.onPaneChanged('%5', true)
        titles.onProgramTitle(markerTitle('%4'))
        titles.onProgramTitle('from %4')
        expect(tab.title).toBe('tmux:2')
        titles.onProgramTitle(markerTitle('%5'))
        titles.onProgramTitle('from %5')
        expect(tab.title).toBe('from %5')
    })

    it('does not wait when no marker was written', async () => {
        const { tab, titles } = await attached()
        await titles.onPaneChanged('%4', false)
        titles.onProgramTitle('editor')
        expect(tab.title).toBe('editor')
    })

    it('stops waiting on attach (a reconnect writes no old marker)', async () => {
        const { tab, titles } = await attached()
        await titles.onPaneChanged('%4', true)
        await titles.attach({ index: 2, paneId: '%4', name: 'tmux:2', automaticRename: false })
        titles.onProgramTitle('after reconnect')
        expect(tab.title).toBe('after reconnect')
    })
})

describe('TabTitleController: attach order', () => {
    it('sends the pinning rename before reading the pane title', async () => {
        const tab = new FakeTab()
        const titles = new TabTitleController(tab)
        await titles.attach({ index: 5, paneId: '%1', name: 'zsh', automaticRename: true })
        expect(tab.log).toEqual(['rename tmux:5', 'read %1'])
    })

    it('reads without renaming when the window is already pinned', async () => {
        const { tab } = await attached()
        expect(tab.log).toEqual(['read %3'])
    })
})

describe('customTitleAction', () => {
    const base = { previous: '', current: 'api', bound: true, focused: true, paneCount: 1, containerTitle: 'tmux:2' }

    it('renames on a new custom title in a lone tab', () => {
        expect(customTitleAction(base)).toBe('rename')
    })

    it('renames to the title the lone tab shows (pinning a program title)', () => {
        expect(customTitleAction({ ...base, current: 'fix login bug', containerTitle: 'fix login bug' })).toBe('rename')
    })

    it('ignores an unchanged custom title, so unrelated split events push nothing', () => {
        expect(customTitleAction({ ...base, previous: 'work', current: 'work' })).toBe('ignore')
    })

    it('ignores a split rename while another pane is focused, and later events too', () => {
        expect(customTitleAction({ ...base, current: 'work', focused: false, paneCount: 2 })).toBe('ignore')
        // e.g. "Split right" later, with this pane focused: the name did not change
        expect(customTitleAction({ ...base, previous: 'work', current: 'work', paneCount: 3 })).toBe('ignore')
    })

    it('clears, without renaming, an unedited OK in a split (the joined titles)', () => {
        expect(customTitleAction({ ...base, current: 'right job | left job', paneCount: 2, containerTitle: 'right job | left job' })).toBe('clear')
    })

    it('renames when a split is given a real name', () => {
        expect(customTitleAction({ ...base, current: 'api', paneCount: 2, containerTitle: 'right job | left job' })).toBe('rename')
    })

    it('ignores a cleared custom title and an unbound pane', () => {
        expect(customTitleAction({ ...base, previous: 'api', current: '' })).toBe('ignore')
        expect(customTitleAction({ ...base, bound: false })).toBe('ignore')
        expect(customTitleAction({ ...base, current: '   ' })).toBe('ignore')
    })
})
