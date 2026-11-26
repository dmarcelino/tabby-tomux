// SPDX-License-Identifier: GPL-3.0-only
/**
 * TomuxService opening tabs for windows no tab claimed (change
 * adopted-tab-profile-look, design D4). tabby-core does not load under Node,
 * so it is stubbed with the few names the service uses at runtime; the
 * connection is a real TomuxConnection on FakeTmux.
 */
import { NgZone } from '@angular/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService, BOOTSTRAP_DATA, ProfilesService } from 'tabby-core'
import type { TomuxProfile } from './profile'
import { TomuxService } from './tomux.service'
import { TomuxConnection } from './tmux/connection'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'

vi.mock('tabby-core', () => ({
    AppService: class AppService {},
    LogService: class LogService {},
    ProfilesService: class ProfilesService {},
    SplitTabComponent: class SplitTabComponent {},
    BOOTSTRAP_DATA: 'BOOTSTRAP_DATA',
}))

const SSH_PROFILE = { id: 'ssh:work', type: 'ssh', name: 'work', options: { host: 'work.example' } }

function tomuxProfile (extra: Partial<TomuxProfile> = {}): TomuxProfile {
    return {
        id: 'tomux:work-server',
        type: 'tomux',
        name: 'work-server',
        options: { sshProfileId: SSH_PROFILE.id, sessionName: 'main' },
        ...extra,
    } as TomuxProfile
}

/** Inputs of every tab the service asked Tabby to open. */
let opened: Record<string, any>[]
let tmux: FakeTmux | null

function makeService (): TomuxService {
    const app = { openNewTab: (params: { inputs: Record<string, any> }) => { opened.push(params.inputs); return {} } }
    const profiles = {
        getProfiles: async () => [SSH_PROFILE],
        getConfigProxyForProfile: (profile: unknown) => profile,
    }
    const zone = { run: (fn: () => unknown) => fn(), runOutsideAngular: (fn: () => unknown) => fn() }
    const services = new Map<unknown, unknown>([
        [AppService, app],
        [ProfilesService, profiles],
        [NgZone, zone],
        // Not the main Tabby window: the tab-order sync stays off.
        [BOOTSTRAP_DATA, { isMainWindow: false }],
    ])
    const injector = { get: (token: unknown, notFound?: unknown) => services.has(token) ? services.get(token) : notFound }
    const log = { create: () => ({ debug () {}, info () {}, warn () {}, error () {} }) }
    const service = new TomuxService(injector as any, log as any)
    service.tabComponent = class FakeTomuxTab {} as any
    return service
}

/** Opens the session through the service, as the first tab of a profile does. */
async function connect (service: TomuxService, profile: TomuxProfile, windows: string[]): Promise<void> {
    tmux = new FakeTmux({ windows, startupNotifications: ['%sessions-changed'] })
    const transport = tmux
    await service.acquire('work|main', () => TomuxConnection.open(transport, 'main'), { tomuxProfile: profile, sshProfile: SSH_PROFILE as any })
}

beforeEach(() => {
    vi.useFakeTimers()
    opened = []
    tmux = null
})

afterEach(async () => {
    tmux?.channel?.exit()
    await settle()
    vi.useRealTimers()
})

describe('TomuxService: tabs for windows no tab claimed', () => {
    it('gives the tabs it opens when a session connects the title, colour and icon of the tomux profile', async () => {
        const service = makeService()
        await connect(service, tomuxProfile({ color: '#c00', icon: 'fas fa-server' }), ['@1|0|%1|1|1||bash', '@2|1|%2|0|1||bash'])

        await vi.advanceTimersByTimeAsync(2500)
        await settle()

        expect(opened.map(inputs => inputs.tomuxIntent)).toEqual([
            { kind: 'adopt', windowId: '@1' },
            { kind: 'adopt', windowId: '@2' },
        ])
        for (const inputs of opened) {
            expect(inputs).toMatchObject({ title: 'work-server', color: '#c00', icon: 'fas fa-server' })
        }
    })

    it('gives a window created later the same look', async () => {
        const service = makeService()
        await connect(service, tomuxProfile({ color: '#c00', icon: 'fas fa-server' }), ['@1|0|%1|1|1||bash'])

        tmux!.channel.send('%window-add @3\r\n')
        await settle(50)

        expect(opened).toHaveLength(1)
        expect(opened[0]).toMatchObject({
            tomuxIntent: { kind: 'adopt', windowId: '@3' },
            title: 'work-server',
            color: '#c00',
            icon: 'fas fa-server',
        })
    })

    it('gives no colour or icon when the profile has none', async () => {
        const service = makeService()
        // A profile config proxy reads an unset colour or icon as ''.
        await connect(service, tomuxProfile({ color: '', icon: '' }), ['@1|0|%1|1|1||bash', '@2|1|%2|0|1||bash'])

        await vi.advanceTimersByTimeAsync(2500)
        await settle()

        expect(opened).toHaveLength(2)
        for (const inputs of opened) {
            expect(inputs).toMatchObject({ title: 'work-server', color: null, icon: null })
        }
    })
})
