// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { activeTomuxTab, FollowableTab, followedTabInputs, followedTabLook, tabToFollow } from './followActiveTab'
import type { TomuxProfile } from './profile'

function tomuxProfile (id: string, sessionName: string, extra: Partial<TomuxProfile> = {}): TomuxProfile {
    return { id, type: 'tomux', name: id, options: { sshProfileId: `ssh-${id}`, sessionName }, ...extra } as TomuxProfile
}

class FakeTomuxTab implements FollowableTab {
    connected = true
    constructor (
        public tomuxProfile: TomuxProfile,
        public sessionName: string,
        public profile: any = { id: `ssh-${tomuxProfile.id}`, options: { host: 'h' } },
        public tomuxError?: string,
    ) {}
}

class FakeSplit {
    constructor (public focused: unknown) {}
}

const isTomuxTab = (tab: unknown): tab is FakeTomuxTab => tab instanceof FakeTomuxTab
const focusedPaneOf = (tab: unknown): unknown => tab instanceof FakeSplit ? tab.focused : null

const DEFAULT = 'tomux:work-server'

describe('activeTomuxTab', () => {
    const tab = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')

    it('returns the active tab when it is a tomux tab', () => {
        expect(activeTomuxTab(tab, isTomuxTab, focusedPaneOf)).toBe(tab)
    })

    it('returns the focused pane of a split when it is a tomux tab', () => {
        expect(activeTomuxTab(new FakeSplit(tab), isTomuxTab, focusedPaneOf)).toBe(tab)
    })

    it('returns null for a split whose focused pane is not a tomux tab, or that has none', () => {
        expect(activeTomuxTab(new FakeSplit({ local: true }), isTomuxTab, focusedPaneOf)).toBeNull()
        expect(activeTomuxTab(new FakeSplit(null), isTomuxTab, focusedPaneOf)).toBeNull()
    })

    it('returns null for a non-tomux tab or no active tab', () => {
        expect(activeTomuxTab({ local: true }, isTomuxTab, focusedPaneOf)).toBeNull()
        expect(activeTomuxTab(null, isTomuxTab, focusedPaneOf)).toBeNull()
    })
})

describe('tabToFollow', () => {
    const tab = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')

    it('follows the active tomux tab when the default profile is opened', () => {
        expect(tabToFollow(DEFAULT, DEFAULT, tab)).toBe(tab)
    })

    it('uses the requested profile when another profile is opened', () => {
        expect(tabToFollow('tomux:db-box', DEFAULT, tab)).toBeNull()
    })

    it('uses the requested profile when the active tab is not a tomux tab or there is none', () => {
        expect(tabToFollow(DEFAULT, DEFAULT, null)).toBeNull()
    })

    it('uses the requested profile when the active tomux tab shows a profile error', () => {
        const broken = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci', undefined, 'SSH profile missing')
        expect(tabToFollow(DEFAULT, DEFAULT, broken)).toBeNull()
    })

    it('uses the requested profile when it has no id, or no default is configured', () => {
        expect(tabToFollow(undefined, DEFAULT, tab)).toBeNull()
        expect(tabToFollow(undefined, undefined, tab)).toBeNull()
        expect(tabToFollow(DEFAULT, undefined, tab)).toBeNull()
    })

    it('follows a disconnected tab too', () => {
        const dropped = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')
        dropped.connected = false
        expect(tabToFollow(DEFAULT, DEFAULT, dropped)).toBe(dropped)
    })
})

describe('followedTabInputs', () => {
    it('carries the tab\'s own SSH profile, tomux profile and session, with a new-window intent', () => {
        // The profile's session was changed to ci2 after the tab opened on ci.
        const profile = tomuxProfile('build-box', 'ci2')
        const ssh = { id: 'ssh-build-box', options: { host: 'old-host' } }
        const tab = new FakeTomuxTab(profile, 'ci', ssh)
        const inputs = followedTabInputs(tab)
        expect(inputs.profile).toBe(ssh)
        expect(inputs.tomuxProfile).toBe(profile)
        expect(inputs.tomuxSessionName).toBe('ci')
        expect(inputs.tomuxIntent).toEqual({ kind: 'new' })
        expect(inputs.tomuxFollowed).toBe(true)
    })
})

describe('followedTabLook', () => {
    it('takes name, colour and icon from the tomux profile', () => {
        expect(followedTabLook(tomuxProfile('build-box', 'ci', { color: '#00f', icon: 'fas fa-box' })))
            .toEqual({ title: 'build-box', color: '#00f', icon: 'fas fa-box' })
    })

    it('clears colour and icon the profile does not have', () => {
        expect(followedTabLook(tomuxProfile('build-box', 'ci')))
            .toEqual({ title: 'build-box', color: null, icon: null })
    })

    it('treats the empty colour and icon of a profile config proxy as none', () => {
        expect(followedTabLook(tomuxProfile('build-box', 'ci', { color: '', icon: '' })))
            .toEqual({ title: 'build-box', color: null, icon: null })
    })
})
