// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { activeTomuxTab, FollowableTab, followedTabInputs, followedTabWasReplaced, tabToFollow } from './followActiveTab'
import type { TomuxTabInputs } from './tomux.service'
import type { TomuxProfile } from './profile'

function tomuxProfile (id: string, sessionName: string): TomuxProfile {
    return { id, type: 'tomux', name: id, options: { sshProfileId: `ssh-${id}`, sessionName } } as TomuxProfile
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
const exists = (): boolean => true

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
        expect(tabToFollow(DEFAULT, DEFAULT, tab, exists)).toBe(tab)
    })

    it('uses the requested profile when another profile is opened', () => {
        expect(tabToFollow('tomux:db-box', DEFAULT, tab, exists)).toBeNull()
    })

    it('uses the requested profile when the active tab is not a tomux tab or there is none', () => {
        expect(tabToFollow(DEFAULT, DEFAULT, null, exists)).toBeNull()
    })

    it('uses the requested profile when the active tomux tab shows a profile error', () => {
        const broken = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci', undefined, 'SSH profile missing')
        expect(tabToFollow(DEFAULT, DEFAULT, broken, exists)).toBeNull()
    })

    it('uses the requested profile when it has no id, or no default is configured', () => {
        expect(tabToFollow(undefined, DEFAULT, tab, exists)).toBeNull()
        expect(tabToFollow(undefined, undefined, tab, exists)).toBeNull()
        expect(tabToFollow(DEFAULT, undefined, tab, exists)).toBeNull()
    })

    it('uses the requested profile when the active tab\'s session name is invalid', () => {
        for (const name of ['a.b', 'a:b', '', ' ci']) {
            const bad = new FakeTomuxTab(tomuxProfile('build-box', name), name)
            expect(tabToFollow(DEFAULT, DEFAULT, bad, exists)).toBeNull()
        }
    })

    it('uses the requested profile when the tab\'s tomux or SSH profile was deleted since it opened', () => {
        const without = (gone: string) => (id: string): boolean => id !== gone
        expect(tabToFollow(DEFAULT, DEFAULT, tab, without('build-box'))).toBeNull()
        expect(tabToFollow(DEFAULT, DEFAULT, tab, without('ssh-build-box'))).toBeNull()
        expect(tabToFollow(DEFAULT, DEFAULT, tab, without('something-else'))).toBe(tab)
    })

    it('follows a disconnected tab too', () => {
        const dropped = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')
        dropped.connected = false
        expect(tabToFollow(DEFAULT, DEFAULT, dropped, exists)).toBe(dropped)
    })
})

describe('followedTabInputs', () => {
    it('carries the tab\'s own SSH profile, tomux profile and session, with a new-window intent', () => {
        // The profile's session was changed to ci2 after the tab opened on ci.
        const profile = tomuxProfile('build-box', 'ci2')
        const ssh = { id: 'ssh-build-box', options: { host: 'old-host' } }
        const tab = new FakeTomuxTab(profile, 'ci', ssh)
        const container = { getAllTabs: () => [tab] }
        const unfollowed = { tomuxProfile: tomuxProfile('work-server', 'main') } as TomuxTabInputs
        const inputs = followedTabInputs(tab, container, unfollowed)
        expect(inputs.profile).toBe(ssh)
        expect(inputs.tomuxProfile).toBe(profile)
        expect(inputs.tomuxSessionName).toBe('ci')
        expect(inputs.tomuxIntent).toEqual({ kind: 'new' })
        expect(inputs.tomuxFollowed).toBe(true)
        expect(inputs.tomuxFollowedFrom).toEqual({ tab, container })
        expect(inputs.tomuxUnfollowed).toBe(unfollowed)
    })
})

describe('followedTabWasReplaced', () => {
    const tab = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')
    const other = new FakeTomuxTab(tomuxProfile('build-box', 'ci'), 'ci')

    it('is false for `+`: the followed tab is still in its split', () => {
        expect(followedTabWasReplaced(tab, { getAllTabs: () => [other, tab] })).toBe(false)
    })

    it('is true for Switch profile: the new tab took the followed tab\'s place', () => {
        expect(followedTabWasReplaced(tab, { getAllTabs: () => [other] })).toBe(true)
    })

    it('is false for a tab that had no split', () => {
        expect(followedTabWasReplaced(tab, null)).toBe(false)
    })
})
