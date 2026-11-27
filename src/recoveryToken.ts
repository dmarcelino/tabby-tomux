// SPDX-License-Identifier: GPL-3.0-only
/**
 * tomux tab recovery tokens (design D7, spec tmux-tab-recovery). Tabby asks a
 * tab for a token when it saves tabs for restore, restarts or duplicates a
 * tab, or pushes a closed tab onto its reopen stack:
 *   - includeState absent (duplicate, split)  -> no windowId -> a new window
 *   - includeState, tab closed by the user    -> windowId + userClosed -> reopen
 *   - includeState otherwise (save, restart)  -> windowId -> adopt that window
 * With includeState, the window is the one the tab is bound to or, for a tab
 * not shown yet and so not bound, the window its intent names (none for a
 * `new` intent). A tab never shown thus keeps its window across restarts.
 * Tokens never carry Tabby's saved screen: tmux's capture-pane provides it.
 */
import type { BindIntent } from './binding'

export const TOMUX_TOKEN_TYPE = 'app:tomux-tab'

export interface TomuxTokenFields {
    tomuxProfileId: string
    sessionName: string
    windowId?: string
    userClosed?: boolean
}

export interface TomuxRecoveryToken extends TomuxTokenFields {
    type: typeof TOMUX_TOKEN_TYPE
}

export function makeRecoveryToken (args: {
    tomuxProfileId: string
    sessionName: string
    windowId: string | null
    intent: BindIntent
    includeState: boolean
    userClosed: boolean
}): TomuxRecoveryToken {
    const token: TomuxRecoveryToken = {
        type: TOMUX_TOKEN_TYPE,
        tomuxProfileId: args.tomuxProfileId,
        sessionName: args.sessionName,
    }
    const windowId = args.windowId ?? (args.intent.kind === 'new' ? null : args.intent.windowId)
    if (args.includeState && windowId) {
        token.windowId = windowId
        if (args.userClosed) {
            token.userClosed = true
        }
    }
    return token
}

export function isTomuxToken (token: { type?: unknown }): token is TomuxRecoveryToken {
    return token.type === TOMUX_TOKEN_TYPE
        && typeof (token as any).tomuxProfileId === 'string'
        && typeof (token as any).sessionName === 'string'
}

export function intentFromToken (token: TomuxRecoveryToken): BindIntent {
    if (!token.windowId) {
        return { kind: 'new' }
    }
    return token.userClosed
        ? { kind: 'reopen', windowId: token.windowId }
        : { kind: 'adopt', windowId: token.windowId }
}
