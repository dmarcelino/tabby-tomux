// SPDX-License-Identifier: GPL-3.0-only
import type { Profile } from 'tabby-core'

export const TOMUX_PROFILE_TYPE = 'tomux'

/** A tomux profile points at an existing Tabby SSH profile plus a tmux session name. */
export interface TomuxProfile extends Profile {
    options: {
        sshProfileId: string
        sessionName: string
    }
}

/** What a TomuxTab needs to know about where it belongs and which window to bind. */
export interface TomuxTabSpec {
    tomuxProfileId: string
    sessionName: string
    intent: import('./binding').BindIntent
}
