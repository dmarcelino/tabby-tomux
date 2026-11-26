// SPDX-License-Identifier: GPL-3.0-only
/**
 * `+` follows the active tomux tab (change plus-follows-active-tab, spec
 * tomux-profile "Plus button and new-tab hotkey", design D1-D5). Pure, so
 * every rule is unit-tested; TomuxProfileProvider supplies the Tabby facts.
 */
import type { TomuxProfile } from './profile'
import { sessionNameError } from './sessionName'
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
 * (D4): only a tab that cannot connect anywhere is not followed. That covers
 * an error set when the tab was created, a session name tmux rejects, and a
 * tomux or SSH profile deleted since (`profileExists` answers for the ids).
 */
export function tabToFollow<T extends FollowableTab> (
    requestedProfileId: string | undefined,
    defaultProfileId: string | undefined,
    activeTab: T | null,
    profileExists: (id: string) => boolean,
): T | null {
    if (!requestedProfileId || requestedProfileId !== defaultProfileId) {
        return null
    }
    if (!activeTab || activeTab.tomuxError || sessionNameError(activeTab.sessionName)) {
        return null
    }
    const ids = [activeTab.tomuxProfile?.id, activeTab.profile?.id]
    if (!ids.every(id => typeof id === 'string' && profileExists(id))) {
        return null
    }
    return activeTab
}

/**
 * Inputs for a tab that follows `tab`: the tab's own SSH profile, tomux
 * profile and session, not values looked up again from the profile id, so it
 * gets the same connection key (D3).
 */
export function followedTabInputs (tab: FollowableTab, container: TabContainer | null, unfollowed: TomuxTabInputs): TomuxTabInputs {
    return {
        profile: tab.profile,
        tomuxProfile: tab.tomuxProfile,
        tomuxIntent: { kind: 'new' },
        tomuxSessionName: tab.sessionName,
        tomuxFollowed: true,
        tomuxFollowedFrom: { tab, container },
        tomuxUnfollowed: unfollowed,
    }
}

/** The split that held a followed tab (Tabby's SplitTabComponent). */
export interface TabContainer {
    getAllTabs (): unknown[]
}

/**
 * True when the followed tab left the split it was in by the time the new tab
 * starts. Tabby's "Switch profile" builds the replacement through the same
 * path as `+` and then puts it in the old tab's place, so this is how the new
 * tab tells a switch from `+`: it then opens the profile that was asked for
 * (design D6). A tab that had no split is never treated as replaced.
 */
export function followedTabWasReplaced (tab: unknown, container: TabContainer | null): boolean {
    return container !== null && !container.getAllTabs().includes(tab)
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
