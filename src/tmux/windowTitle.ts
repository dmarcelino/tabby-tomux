// SPDX-License-Identifier: GPL-3.0-only
//
// Ported from tmux-integrated src/windowTitle.ts at commit 0f92f4a.
// Copyright (C) the tmux-integrated authors
//
// Changes: comments adapted from VS Code to Tabby; logic unchanged.

/**
 * Tabby tab titles from tmux `#{window_name}`.
 *
 * Two cooperating pieces live here, both free of Tabby imports so they can
 * be unit-tested directly:
 *
 *   - `pickTerminalTabTitle` — pure policy for choosing a tab label from
 *     tmux window metadata (`#{window_name}`, `#{window_index}`,
 *     `#{automatic-rename}`) and the `showAutomaticRename` setting.
 *
 *   - `TabTitleSync` — per-tab state tracker for the bidirectional rename
 *     sync. It remembers every title this plugin has shown for a tab,
 *     tracks in-flight `rename-window` commands so their `%window-renamed`
 *     echoes can be recognised, and classifies the title the tab currently
 *     shows so a *stale* name (an old title the host has not finished
 *     replacing yet) is never mistaken for a user-initiated rename and
 *     pushed back to tmux.
 *
 * When tmux's per-window **automatic-rename** option is on, the title is
 * owned by tmux (shell / cwd / format). By default we normalize those to
 * `tmux:<n>` and pin the name with `rename-window`; when the
 * `showAutomaticRename` setting is enabled we surface tmux's automatic name
 * instead so the tab tracks the foreground process. When automatic-rename is
 * off, the current name is treated as intentional (user or this plugin) and
 * shown as-is.
 *
 * In tmux-integrated the "tab title" is VS Code's `terminal.name`; in tomux
 * it is the Tabby tab's (custom) title. VS Code applies titles asynchronously,
 * which is where the `settling` state comes from; Tabby sets them
 * synchronously, but the classification is kept unchanged (design D9).
 */

/** Interpret `#{automatic-rename}` / `list-windows` field (version-dependent values). */
export function tmuxAutomaticRenameIsOn(value: string | undefined): boolean {
    const v = (value ?? '').trim().toLowerCase();
    return v === '1' || v === 'on' || v === 'yes' || v === 'true';
}

/**
 * @param windowName current `#{window_name}`
 * @param windowIndex zero-based `#{window_index}`
 * @param automaticRename whether tmux is still auto-renaming this window
 * @param showAutomaticRename the `showAutomaticRename` setting (in
 *        tmux-integrated: `tmux-integrated.showAutomaticRename`) —
 *        when true, automatic names are shown instead of being
 *        normalized to `tmux:<n>`
 */
export function pickTerminalTabTitle(
    windowName: string | undefined,
    windowIndex: number | undefined,
    automaticRename: boolean | undefined,
    showAutomaticRename: boolean,
): string {
    const fallback = windowIndex !== undefined ? `tmux:${windowIndex}` : 'tmux';
    if (automaticRename === true && !showAutomaticRename) {
        return fallback;
    }
    const raw = windowName?.trim();
    return raw || fallback;
}

/**
 * How the title a tab shows (VS Code: `terminal.name`) relates to the titles
 * this plugin has pushed:
 *
 *   - `in-sync`     — matches the last title we emitted (or we have not
 *                     emitted anything yet); nothing to do.
 *   - `settling`    — an older title of this tab; VS Code applies
 *                     `onDidChangeName` asynchronously (two extension-host ↔
 *                     renderer hops), so `terminal.name` lags behind our
 *                     latest emission. Must NOT be synced to tmux: doing so
 *                     used to *revert* renames made on the tmux side when the
 *                     user typed before the new title had round-tripped.
 *   - `user-rename` — a title we never produced, so it can only come from
 *                     the user (VS Code's "Rename…", Tabby's "Rename tab"); sync it to tmux.
 */
export type TerminalNameClassification = 'in-sync' | 'settling' | 'user-rename';

/** Pending rename-window echoes older than this are assumed lost (e.g. the command failed). */
const PENDING_RENAME_TTL_MS = 10_000;

/**
 * Upper bound on remembered titles so a long-lived terminal with
 * `showAutomaticRename` enabled (a new title per foreground process)
 * stays bounded. Oldest titles are evicted first.
 */
const MAX_REMEMBERED_TITLES = 200;

export class TabTitleSync {
    private lastEmitted: string | null = null;
    /** Every title this terminal has shown, insertion-ordered for LRU eviction. */
    private readonly knownTitles = new Set<string>();
    /** rename-window commands sent to tmux whose %window-renamed echo has not arrived yet. */
    private readonly pendingTmuxRenames: { name: string; at: number }[] = [];

    constructor(private readonly now: () => number = Date.now) {}

    /** The last title emitted to the tab (VS Code: via onDidChangeName); null before the first emission. */
    get lastEmittedTitle(): string | null {
        return this.lastEmitted;
    }

    /** True once any title has been emitted to the tab. */
    get hasEmitted(): boolean {
        return this.lastEmitted !== null;
    }

    /**
     * Register a title the tab may display without it having gone through
     * `recordEmission` — in VS Code, the creation-options `name`. Seeding
     * it prevents the first keystroke from mis-classifying the not-yet-replaced
     * creation name as a user rename.
     */
    noteKnownTitle(title: string): void {
        this.rememberTitle(title);
    }

    /** Record that `title` was pushed to the tab (or already applied there by the user). */
    recordEmission(title: string): void {
        this.lastEmitted = title;
        this.rememberTitle(title);
    }

    /** Record that `rename-window <name>` was sent, so its echo can be recognised. */
    recordRenameSentToTmux(name: string): void {
        this.prunePendingRenames();
        this.pendingTmuxRenames.push({ name, at: this.now() });
    }

    /**
     * True when a `%window-renamed` for `name` is the echo of a rename this
     * plugin sent (consumes the matching record). Suppressing echoes keeps
     * two quick successive renames from flickering the tab through the older
     * name when the first echo arrives after the second emission.
     */
    /**
     * tomux: true while renames this tab sent to tmux still await their
     * %window-renamed echo. Lets the tab tell "the last echo of my own
     * renames" (show it if a tmux-side rename landed in between) apart from an
     * older echo that a newer rename of ours supersedes (review item 15).
     */
    hasPendingRenames(): boolean {
        this.prunePendingRenames();
        return this.pendingTmuxRenames.length > 0;
    }

    consumeRenameEcho(name: string): boolean {
        this.prunePendingRenames();
        const index = this.pendingTmuxRenames.findIndex((pending) => pending.name === name);
        if (index === -1) {
            return false;
        }
        this.pendingTmuxRenames.splice(index, 1);
        return true;
    }

    /** Classify the title the tab currently shows. See TerminalNameClassification. */
    classifyTerminalName(terminalName: string | undefined): TerminalNameClassification {
        const name = terminalName?.trim();
        if (!name || this.lastEmitted === null || name === this.lastEmitted) {
            return 'in-sync';
        }
        if (this.knownTitles.has(name)) {
            return 'settling';
        }
        return 'user-rename';
    }

    private rememberTitle(title: string): void {
        // Delete-then-add refreshes the insertion order so eviction is LRU-ish.
        this.knownTitles.delete(title);
        this.knownTitles.add(title);
        if (this.knownTitles.size > MAX_REMEMBERED_TITLES) {
            const oldest = this.knownTitles.values().next().value;
            if (oldest !== undefined) {
                this.knownTitles.delete(oldest);
            }
        }
    }

    private prunePendingRenames(): void {
        const cutoff = this.now() - PENDING_RENAME_TTL_MS;
        while (this.pendingTmuxRenames.length > 0 && this.pendingTmuxRenames[0].at < cutoff) {
            this.pendingTmuxRenames.shift();
        }
    }
}
