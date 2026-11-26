// SPDX-License-Identifier: GPL-3.0-only
/**
 * Log lines that say which SSH session a tab's tmux connection runs on (change
 * retry-empty-tmux-version, design D5). Tabs share the connection the first
 * tab opened, on that tab's SSH session.
 */

export interface ConnectContext {
    /** The tab's own SSH session, e.g. "SSH session #2". */
    sessionLabel: string
    /** The tab and its bind intent, e.g. "tab adopt @88". */
    tabLabel: string
}

export type ConnectOutcome =
    | { kind: 'opened' }
    /** `connectionSession` is the session the shared connection runs on. */
    | { kind: 'shared', connectionSession?: string }
    /** `openedHere` is false when the tab joined another tab's attempt. */
    | { kind: 'failed', openedHere: boolean, error: unknown }

export function connectionLogLine (outcome: ConnectOutcome, ctx: ConnectContext): string {
    switch (outcome.kind) {
        case 'opened':
            return `tmux connection opened on ${ctx.sessionLabel} (${ctx.tabLabel})`
        case 'shared':
            return `tmux connection shared, on ${outcome.connectionSession ?? 'an unnamed SSH session'} (${ctx.tabLabel})`
        case 'failed':
            return outcome.openedHere
                ? `tmux connection failed on ${ctx.sessionLabel} (${ctx.tabLabel}): ${outcome.error}`
                : `tmux connection failed in another tab's attempt (${ctx.tabLabel}): ${outcome.error}`
    }
}

/** A warning from the connection, with the session and tab it came from. */
export function withConnectContext (message: string, ctx: ConnectContext): string {
    return `${message} (${ctx.sessionLabel}, ${ctx.tabLabel})`
}
