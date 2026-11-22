// SPDX-License-Identifier: GPL-3.0-only
import { Injectable, Injector } from '@angular/core'
import { NewTabParameters, ProfilesService, RecoveryToken, TabRecoveryProvider } from 'tabby-core'
import { TomuxTabComponent } from './components/tomuxTab.component'
import { TOMUX_PROFILE_TYPE, TomuxProfile } from './profile'
import { intentFromToken, isTomuxToken } from './recoveryToken'
import { TomuxService } from './tomux.service'

/** Turns saved tomux tokens back into tabs (design D7, spec tmux-tab-recovery). */
@Injectable()
export class TomuxRecoveryProvider extends TabRecoveryProvider<TomuxTabComponent> {
    // ProfilesService is looked up lazily: it constructs the profile providers itself (cycle).
    constructor (private injector: Injector) {
        super()
    }

    async applicableTo (token: RecoveryToken): Promise<boolean> {
        return isTomuxToken(token)
    }

    async recover (token: RecoveryToken): Promise<NewTabParameters<TomuxTabComponent>> {
        if (!isTomuxToken(token)) {
            throw new Error('Not a tomux token')
        }
        const found = (await this.injector.get(ProfilesService).getProfiles()).find(p => p.id === token.tomuxProfileId && p.type === TOMUX_PROFILE_TYPE)
        const tomuxProfile = (found
            ? this.injector.get(ProfilesService).getConfigProxyForProfile(found)
            : { id: token.tomuxProfileId, type: TOMUX_PROFILE_TYPE, name: 'tomux', options: { sshProfileId: '', sessionName: token.sessionName } }) as TomuxProfile
        const inputs = await this.injector.get(TomuxService).tabInputs(tomuxProfile, intentFromToken(token))
        // A restored tab goes back to the session it was in, even if the profile changed since.
        inputs.tomuxSessionName = token.sessionName
        if (!found) {
            inputs.tomuxError = `The tomux profile this tab used (id "${token.tomuxProfileId}") no longer exists.`
        }
        return { type: TomuxTabComponent, inputs: inputs as any }
    }
}
