// SPDX-License-Identifier: GPL-3.0-only
/**
 * `+` follows the active tomux tab (change plus-follows-active-tab, spec
 * tomux-profile "Plus button and new-tab hotkey", design D1-D5). Pure, so
 * every rule is unit-tested; TomuxProfileProvider supplies the Tabby facts.
 */
import type { TomuxProfile } from './profile'
import type { TomuxTabInputs } from './tomux.service'

/** What a tomux tab offers to be followed (TomuxTabComponent has all of these). */
export interface FollowableTab {
    profile: any
    tomuxProfile: TomuxProfile
    sessionName: string
    /** Set when the tab cannot connect anywhere (missing SSH or tomux profile). */
    tomuxError?: string
}

/**
 * The tomux tab the user is looking at: the active tab itself, or the focused
 * pane when the active tab is a split. Null when neither is a tomux tab.
 */
export function activeTomuxTab<T> (
    activeTab: unknown,
    isTomuxTab: (tab: unknown) => tab is T,
    focusedPaneOf: (tab: unknown) => unknown,
): T | null {
    if (!activeTab) {
        return null
    }
    if (isTomuxTab(activeTab)) {
        return activeTab
    }
    const pane = focusedPaneOf(activeTab)
    return pane && isTomuxTab(pane) ? pane : null
}

/**
 * The tab a new tab for `requestedProfileId` should follow, or null to use the
 * requested profile as is. Only the default profile follows (D1); `+` gives no
 * other sign that it was pressed. The tab's connection state does not matter
 * (D4): only a tab that cannot connect anywhere is not followed.
 */
export function tabToFollow<T extends FollowableTab> (
    requestedProfileId: string | undefined,
    defaultProfileId: string | undefined,
    activeTab: T | null,
): T | null {
    if (!requestedProfileId || requestedProfileId !== defaultProfileId) {
        return null
    }
    if (!activeTab || activeTab.tomuxError) {
        return null
    }
    return activeTab
}

/**
 * Inputs for a tab that follows `tab`: the tab's own SSH profile, tomux
 * profile and session, not values looked up again from the profile id, so it
 * gets the same connection key (D3).
 */
export function followedTabInputs (tab: FollowableTab): TomuxTabInputs {
    return {
        profile: tab.profile,
        tomuxProfile: tab.tomuxProfile,
        tomuxIntent: { kind: 'new' },
        tomuxSessionName: tab.sessionName,
        tomuxFollowed: true,
    }
}

/**
 * Title, colour and icon of a followed tab. Tabby sets these from the default
 * profile after the provider returns, so the tab sets them again (D5).
 */
export function followedTabLook (tomuxProfile: Pick<TomuxProfile, 'name' | 'color' | 'icon'>): {
    title: string
    color: string | null
    icon: string | null
} {
    // A profile without colour or icon reads as '' through its config proxy;
    // Tabby treats any falsy value as none, so do the same.
    return {
        title: tomuxProfile.name,
        color: tomuxProfile.color || null,
        icon: tomuxProfile.icon || null,
    }
}
