// SPDX-License-Identifier: GPL-3.0-only
/** Spec tomux-profile, "Session name validation". */

export const DEFAULT_SESSION_NAME = 'main'

/**
 * Returns null when tmux can use the name as-is, otherwise a message saying
 * what is wrong. tmux rejects (or silently rewrites) `.` and `:` in session
 * names because they separate session, window and pane in target syntax.
 */
export function sessionNameError (name: string): string | null {
    if (!name.trim()) {
        return 'Enter a tmux session name.'
    }
    if (name !== name.trim()) {
        return 'A tmux session name cannot start or end with a space.'
    }
    const bad = [...new Set([...name].filter(ch => ch === '.' || ch === ':'))]
    if (bad.length) {
        return `tmux does not allow ${bad.map(c => `"${c}"`).join(' or ')} in session names.`
    }
    if ([...name].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
        return 'A tmux session name cannot contain control characters.'
    }
    return null
}
