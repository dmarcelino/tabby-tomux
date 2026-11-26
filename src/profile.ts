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

/** Title, colour and icon of a tab, as Tabby sets them for a tab opened from a profile. */
export interface TabLook {
    title: string
    color: string | null
    icon: string | null
}

/**
 * The look Tabby gives a tab opened from `tomuxProfile`, for the tabs tomux
 * opens itself: a tab that followed the active tab (Tabby set the default
 * profile's look on it, change plus-follows-active-tab D5) and a tab for a
 * window no tab claimed (change adopted-tab-profile-look D1).
 */
export function profileTabLook (tomuxProfile: Pick<TomuxProfile, 'name' | 'color' | 'icon'>): TabLook {
    // A profile without colour or icon reads as '' through its config proxy;
    // Tabby treats any falsy value as none, so do the same.
    return {
        title: tomuxProfile.name,
        color: tomuxProfile.color || null,
        icon: tomuxProfile.icon || null,
    }
}

/** What a TomuxTab needs to know about where it belongs and which window to bind. */
export interface TomuxTabSpec {
    tomuxProfileId: string
    sessionName: string
    intent: import('./binding').BindIntent
}
