// SPDX-License-Identifier: GPL-3.0-only
import { shouldShowRename } from './titleEcho'
import { pickTerminalTabTitle, TabTitleSync } from './tmux/windowTitle'

/**
 * Which title a tomux tab shows (change show-app-titles, design decision 2).
 *
 * Two sources compete for the tab: the tmux window name, and the title the
 * program in the window's active pane sets with OSC 0/2 (Claude Code, shell
 * prompts). A name of the user's own wins, like Tabby's custom title on a
 * local tab. `tmux:<digits>` is tomux's placeholder for "no name", so the
 * program's title shows through it.
 */

const PLACEHOLDER_NAME = /^tmux:\d+$/u

/** True for tomux's placeholder window name `tmux:<digits>`, whatever the current index. */
export function isPlaceholderName (name: string): boolean {
    return PLACEHOLDER_NAME.test(name.trim())
}

export interface DisplayTitleInput {
    /** The tmux window name, if known. */
    windowName?: string
    /** The window index, for the fallback when no name is known. */
    windowIndex?: number
    /** The latest title the program in the active pane set, or null. */
    programTitle?: string | null
    /** The profile's dynamic-title toggle: false ignores program titles. */
    dynamicTitles: boolean
}

/**
 * The tab title: the user's window name, else the program's title (when
 * dynamic titles are on), else the placeholder name as tmux shows it, else
 * `tmux:<index>`.
 */
export function pickDisplayTitle (input: DisplayTitleInput): string {
    const name = input.windowName?.trim() ?? ''
    if (name && !isPlaceholderName(name)) {
        return name
    }
    const program = input.programTitle?.trim() ?? ''
    if (input.dynamicTitles && program) {
        return program
    }
    if (name) {
        return name
    }
    return input.windowIndex !== undefined ? `tmux:${input.windowIndex}` : 'tmux'
}

/**
 * A Kitty graphics command as tmux stores it: `G`, comma-separated
 * `<letter>=<value>` keys (values have no spaces), then `;` and a payload, or
 * nothing (change ignore-kitty-graphics-pane-title, design decision 2).
 */
const KITTY_GRAPHICS_COMMAND = /^G[a-zA-Z]=[^,;\s]*(?:,[a-zA-Z]=[^,;\s]*)*(?:;|$)/u

/**
 * The program title from tmux's `#{pane_title}`, or null when no program has
 * set one: tmux starts every pane with the host name as its title, and an
 * empty OSC title leaves it empty.
 *
 * Also null for a Kitty graphics command (`ESC _ G … ESC \`, such as the
 * image-support query). tmux stores any APC sequence as the pane title, for
 * compatibility with screen, so it replaces the program's real title. xterm.js
 * ignores APC, so a live tab never showed it; only a reattach reads it back.
 */
export function programTitleFromPane (paneTitle: string, host: string): string | null {
    const title = paneTitle.trim()
    if (!title || title === host.trim() || KITTY_GRAPHICS_COMMAND.test(title)) {
        return null
    }
    return title
}

/** A change of the custom title on the tab's top-level container, as one tomux pane sees it. */
export interface CustomTitleEvent {
    /** The custom title the last time this pane looked. */
    previous: string
    /** The custom title now. */
    current: string
    /** This pane is bound to a window over a live connection. */
    bound: boolean
    /** This pane is the container's focused pane (or the container itself). */
    focused: boolean
    /** Panes in the container; 1 for a lone tab. */
    paneCount: number
    /** The title the container shows without a custom title (joined pane titles in a split). */
    containerTitle: string
}

/**
 * What a tomux pane does about Tabby's custom title (design decision 3):
 * - `ignore`: nothing changed, it was cleared, the pane is not bound, or
 *   another pane of the split is focused (the split keeps that name);
 * - `clear`: OK on Tabby's rename dialog in a split without editing it; the
 *   dialog is pre-filled with the joined pane titles, which nobody typed;
 * - `rename`: push the name to tmux, then clear the custom title.
 */
export function customTitleAction (e: CustomTitleEvent): 'ignore' | 'clear' | 'rename' {
    if (e.current === e.previous) {
        return 'ignore'
    }
    const name = e.current.trim()
    if (!name || !e.bound || !e.focused) {
        return 'ignore'
    }
    if (e.paneCount > 1 && name === e.containerTitle.trim()) {
        return 'clear'
    }
    return 'rename'
}

const PANE_SWITCH_PREFIX = 'tomux-pane-switch '

/**
 * An OSC title tomux writes into the tab's terminal right before it redraws a
 * newly active pane. xterm.js parses output later, on a timer, so a title the
 * old pane printed just before the switch can reach the tab after tomux
 * learned about the switch. Titles parsed before this marker belong to the
 * old pane. The marker itself is never shown.
 */
export function paneSwitchMarker (paneId: string): string {
    return `\x1b]2;${PANE_SWITCH_PREFIX}${paneId}\x07`
}

/** What `TabTitleController` needs from the tab. */
export interface TabTitleHost {
    /** Show `title` on the tab. */
    showTitle (title: string): void
    /** Rename the bound tmux window and pin the name. Must not reject. */
    renameWindow (name: string): Promise<void>
    /** The program title tmux holds for `paneId` (see `programTitleFromPane`), or null. Must not reject. */
    readProgramTitle (paneId: string): Promise<string | null>
    /** The profile's dynamic-title toggle. */
    dynamicTitles (): boolean
}

/** The window facts known when a tab attaches. */
export interface TitleWindow {
    index: number
    paneId: string
    name?: string
    automaticRename?: boolean
}

/**
 * The title state of one tomux tab: the tmux window name, synced both ways
 * (design D9 of add-tomux-plugin), and the program title, shown only in Tabby
 * and never sent to tmux.
 *
 * `TabTitleSync` tracks window names only. Program titles stay out of it, so a
 * Tabby rename to the program title the tab shows is still a rename.
 */
export class TabTitleController {
    private readonly sync: TabTitleSync
    private windowName: string | undefined
    private windowIndex: number | undefined
    private programTitle: string | null = null
    private shown: string | null = null
    /** Bumped by every program-title update, so a slower tmux read never overwrites a newer title. */
    private programVersion = 0
    /** Bumped by every attach and pane switch, so only the latest pane read applies. */
    private paneVersion = 0
    /** After a pane switch: the pane whose marker must be parsed before titles count again. */
    private awaitingMarker: string | null = null

    constructor (private readonly host: TabTitleHost, now?: () => number) {
        this.sync = new TabTitleSync(now)
    }

    /** The title the tab shows, or null before the first attach. */
    get displayedTitle (): string | null {
        return this.shown
    }

    /**
     * The tab is bound to its window (new tab, restore or reconnect). Shows
     * the window name or the pane's program title, and pins an automatic
     * name to `tmux:<index>` in tmux.
     */
    async attach (window: TitleWindow): Promise<void> {
        const label = pickTerminalTabTitle(window.name, window.index, window.automaticRename, false)
        this.windowIndex = window.index
        this.awaitingMarker = null // a new connection's pane session writes no old marker
        this.setWindowName(label)
        // Pin before reading the pane title: the pin is decided from the
        // window list read during bind, so a user rename landing during an
        // extra round trip first would be overwritten.
        let pin: Promise<void> | null = null
        if (window.automaticRename !== false || (window.name ?? '') !== label) {
            this.sync.recordRenameSentToTmux(label)
            pin = this.host.renameWindow(label)
        }
        await this.loadProgramTitle(window.paneId)
        this.refresh()
        await pin
    }

    /** `%window-renamed` for this tab's window. */
    onWindowRenamed (name: string): void {
        if (shouldShowRename(this.sync, name)) {
            this.setWindowName(name)
            this.refresh()
        }
    }

    /** The program in the pane set a title (OSC 0/2). Sends nothing to tmux. */
    onProgramTitle (title: string): void {
        if (title.startsWith(PANE_SWITCH_PREFIX)) {
            if (this.awaitingMarker !== null && title === PANE_SWITCH_PREFIX + this.awaitingMarker) {
                this.awaitingMarker = null
            }
            return
        }
        if (this.awaitingMarker !== null) {
            return // parsed from the old pane's output
        }
        this.programVersion++
        this.programTitle = title.trim() || null
        this.refresh()
    }

    /**
     * tmux's active pane of this window changed: take the new pane's title.
     * `markerWritten`: the pane session writes `paneSwitchMarker(paneId)`
     * before the new pane's output, so earlier titles are ignored until it.
     */
    async onPaneChanged (paneId: string, markerWritten: boolean): Promise<void> {
        this.awaitingMarker = markerWritten ? paneId : null
        await this.loadProgramTitle(paneId)
        this.refresh()
    }

    /**
     * The user renamed the tab in Tabby to `customTitle`. Anything but the
     * current window name renames the tmux window. The caller clears Tabby's
     * custom title afterwards, so the tab keeps following tmux.
     */
    onTabbyRename (customTitle: string): void {
        const name = customTitle.trim()
        if (!name || name === this.windowName) {
            return
        }
        this.sync.recordRenameSentToTmux(name)
        this.setWindowName(name)
        this.refresh()
        void this.host.renameWindow(name)
    }

    private async loadProgramTitle (paneId: string): Promise<void> {
        const pane = ++this.paneVersion
        const program = this.programVersion
        if (!this.host.dynamicTitles()) {
            return
        }
        const title = await this.host.readProgramTitle(paneId)
        if (pane === this.paneVersion && program === this.programVersion) {
            this.programTitle = title
        }
    }

    private setWindowName (name: string): void {
        const trimmed = name.trim()
        if (!trimmed) {
            return
        }
        this.windowName = trimmed
        if (trimmed !== this.sync.lastEmittedTitle) {
            this.sync.recordEmission(trimmed)
        }
    }

    private refresh (): void {
        if (this.windowName === undefined && this.windowIndex === undefined) {
            return // not attached yet
        }
        const title = pickDisplayTitle({
            windowName: this.windowName,
            windowIndex: this.windowIndex,
            programTitle: this.programTitle,
            dynamicTitles: this.host.dynamicTitles(),
        })
        if (title !== this.shown) {
            this.shown = title
            this.host.showTitle(title)
        }
    }
}
