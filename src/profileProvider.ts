// SPDX-License-Identifier: GPL-3.0-only
import { Injectable, Injector } from '@angular/core'
import { NewTabParameters, PartialProfile, ProfileProvider, ProfilesService } from 'tabby-core'
import { TomuxProfileSettingsComponent } from './components/profileSettings.component'
import { TomuxTabComponent } from './components/tomuxTab.component'
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

    // ProfilesService is looked up lazily: it constructs the profile providers itself (cycle).
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
        return {
            type: TomuxTabComponent,
            inputs: await this.injector.get(TomuxService).tabInputs(profile, { kind: 'new' }) as any,
        }
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
