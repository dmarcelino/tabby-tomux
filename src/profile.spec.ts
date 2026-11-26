// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { profileTabLook, TomuxProfile } from './profile'

function tomuxProfile (id: string, extra: Partial<TomuxProfile> = {}): TomuxProfile {
    return { id, type: 'tomux', name: id, options: { sshProfileId: `ssh-${id}`, sessionName: 'main' }, ...extra } as TomuxProfile
}

describe('profileTabLook', () => {
    it('takes name, colour and icon from the tomux profile', () => {
        expect(profileTabLook(tomuxProfile('build-box', { color: '#00f', icon: 'fas fa-box' })))
            .toEqual({ title: 'build-box', color: '#00f', icon: 'fas fa-box' })
    })

    it('clears colour and icon the profile does not have', () => {
        expect(profileTabLook(tomuxProfile('build-box')))
            .toEqual({ title: 'build-box', color: null, icon: null })
    })

    it('treats the empty colour and icon of a profile config proxy as none', () => {
        expect(profileTabLook(tomuxProfile('build-box', { color: '', icon: '' })))
            .toEqual({ title: 'build-box', color: null, icon: null })
    })
})
