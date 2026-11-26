// SPDX-License-Identifier: GPL-3.0-only
import { Injectable, Injector } from '@angular/core'
import { AppService, ConfigService, NewTabParameters, PartialProfile, ProfileProvider, ProfilesService, SplitTabComponent } from 'tabby-core'
import { TomuxProfileSettingsComponent } from './components/profileSettings.component'
import { TomuxTabComponent } from './components/tomuxTab.component'
import { activeTomuxTab, followedTabInputs, tabToFollow } from './followActiveTab'
import { TOMUX_PROFILE_TYPE, TomuxProfile } from './profile'
import { TomuxService } from './tomux.service'
import { DEFAULT_SESSION_NAME } from './sessionName'

/** Adds the tomux profile type to Tabby (spec tomux-profile, design D10). */
@Injectable({ providedIn: 'root' })
export class TomuxProfileProvider extends ProfileProvider<TomuxProfile> {
    id = TOMUX_PROFILE_TYPE
    name = 'tomux (tmux windows as tabs)'
    settingsComponent = TomuxProfileSettingsComponent
    configDefaults = {
        options: {
            sshProfileId: '',
            sessionName: DEFAULT_SESSION_NAME,
        },
    }

    // ProfilesService and AppService are looked up lazily: both end up constructing tomux's providers (cycle).
    constructor (private injector: Injector) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<TomuxProfile>[]> {
        // A template so "New profile" in Tabby's settings offers the tomux type.
        return [{
            id: 'tomux:template',
            type: TOMUX_PROFILE_TYPE,
            name: 'tomux: tmux session over SSH',
            icon: 'fas fa-layer-group',
            options: { sshProfileId: '', sessionName: DEFAULT_SESSION_NAME },
            isBuiltin: true,
            isTemplate: true,
        }]
    }

    async getNewTabParameters (profile: TomuxProfile): Promise<NewTabParameters<TomuxTabComponent>> {
        // `+` and the new-tab hotkey open the default profile: they add a
        // window to the session of the tomux tab the user is looking at
        // instead (spec tomux-profile, change plus-follows-active-tab).
        const active = this.activeTomuxTab()
        // A tab can outlive its profiles: check they still exist (design D4).
        const profileIds = new Set(active ? (await this.injector.get(ProfilesService).getProfiles()).map(p => p.id) : [])
        const followed = tabToFollow(profile.id, this.injector.get(ConfigService).store.terminal?.profile, active, id => profileIds.has(id))
        const requested = await this.injector.get(TomuxService).tabInputs(profile, { kind: 'new' })
        return {
            type: TomuxTabComponent,
            inputs: (followed
                ? followedTabInputs(followed, followed.parent instanceof SplitTabComponent ? followed.parent : null, requested)
                : requested) as any,
        }
    }

    /** The active tomux tab, or a split's focused tomux pane. AppService is looked up lazily (cycle). */
    private activeTomuxTab (): TomuxTabComponent | null {
        return activeTomuxTab(
            this.injector.get(AppService).activeTab,
            (tab): tab is TomuxTabComponent => tab instanceof TomuxTabComponent,
            tab => tab instanceof SplitTabComponent ? tab.getFocusedTab() : null,
        )
    }

    getDescription (profile: PartialProfile<TomuxProfile>): string {
        const session = profile.options?.sessionName || DEFAULT_SESSION_NAME
        return `tmux session "${session}"`
    }

    /** The SSH profile a tomux profile points at, or null if it was deleted. */
    async resolveSshProfile (profile: PartialProfile<TomuxProfile>): Promise<PartialProfile<any> | null> {
        const id = profile.options?.sshProfileId
        if (!id) {
            return null
        }
        return (await this.injector.get(ProfilesService).getProfiles()).find(p => p.id === id && p.type === 'ssh') ?? null
    }
}
