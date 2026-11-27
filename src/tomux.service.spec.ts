// SPDX-License-Identifier: GPL-3.0-only
/**
 * TomuxService opening tabs for windows no tab claimed (change
 * adopted-tab-profile-look, design D4) and recording their tab order (change
 * record-order-other-windows). tabby-core does not load under Node, so it is
 * stubbed with the few names the service uses at runtime; the connection is a
 * real TomuxConnection on FakeTmux.
 */
import { NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService, ProfilesService } from 'tabby-core'
import type { TomuxProfile } from './profile'
import { TomuxService } from './tomux.service'
import { TomuxConnection } from './tmux/connection'
import { FakeTmux, settle } from './tmux/fakeTmux.testing'

vi.mock('tabby-core', () => ({
    AppService: class AppService {},
    LogService: class LogService {},
    ProfilesService: class ProfilesService {},
    SplitTabComponent: class SplitTabComponent {},
}))

const SSH_PROFILE = { id: 'ssh:work', type: 'ssh', name: 'work', options: { host: 'work.example' } }
const KEY = 'work|main'

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
/** The fake tab bar: one object per tab, in bar order. */
let app: { tabs: object[], tabsChanged$: Subject<void>, openNewTab: (params: { inputs: Record<string, any> }) => object }
/** The tab opened for each window. */
let tabFor: Map<string, object>

function makeService (): TomuxService {
    const tabs: object[] = []
    app = {
        tabs,
        tabsChanged$: new Subject<void>(),
        openNewTab: params => {
            opened.push(params.inputs)
            // Like a background TomuxTab, the tab holds its window by reservation until shown.
            const tab = { windowId: params.inputs.tomuxIntent?.windowId }
            if (tab.windowId) {
                service.reservations.reserve(KEY, tab.windowId, tab, 'bound')
                tabFor.set(tab.windowId, tab)
            }
            tabs.push(tab)
            return tab
        },
    }
    const profiles = {
        getProfiles: async () => [SSH_PROFILE],
        getConfigProxyForProfile: (profile: unknown) => profile,
    }
    const zone = { run: (fn: () => unknown) => fn(), runOutsideAngular: (fn: () => unknown) => fn() }
    const services = new Map<unknown, unknown>([
        [AppService, app],
        [ProfilesService, profiles],
        [NgZone, zone],
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
    await service.acquire(KEY, () => TomuxConnection.open(transport, 'main'), { tomuxProfile: profile, sshProfile: SSH_PROFILE as any })
}

beforeEach(() => {
    vi.useFakeTimers()
    opened = []
    tmux = null
    tabFor = new Map()
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

/** `@tomux-order` of each window as the fake tmux holds it. */
function recordedOrder (...windowIds: string[]): (string | undefined)[] {
    return windowIds.map(id => tmux!.windowOptions.get(id)?.get('@tomux-order'))
}

function orderWrites (): string[] {
    return tmux!.channel.commands.filter(c => c.includes('@tomux-order'))
}

/** Connects, lets adoption open a tab per window and the first sync run. */
async function adoptTwoWindows (): Promise<void> {
    const service = makeService()
    await connect(service, tomuxProfile(), ['@1|0|%1|1|1||bash', '@2|1|%2|0|1||bash'])
    await vi.advanceTimersByTimeAsync(2500)
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await settle()
}

/** Drags the tab for `windowId` to the far left of the fake tab bar. */
function dragToFront (windowId: string): void {
    const tab = tabFor.get(windowId)!
    app.tabs.splice(app.tabs.indexOf(tab), 1)
    app.tabs.unshift(tab)
    app.tabsChanged$.next()
}

describe('TomuxService: tab order in any Tabby window', () => {
    it('records the order of a reordered session in a Tabby window that is not the main one', async () => {
        await adoptTwoWindows()
        expect(recordedOrder('@1', '@2')).toEqual(['0', '1'])

        dragToFront('@2')
        await vi.advanceTimersByTimeAsync(5000)
        await settle()

        expect(recordedOrder('@1', '@2')).toEqual(['1', '0'])
        // Recording the order does not touch tmux window numbers.
        expect(tmux!.channel.commands.filter(c => /^(move|swap)-window/u.test(c))).toEqual([])
    })

    it('leaves another client\'s later order alone while its own tab bar is unchanged', async () => {
        await adoptTwoWindows()
        dragToFront('@2')
        await vi.advanceTimersByTimeAsync(1000)
        await settle()
        expect(recordedOrder('@1', '@2')).toEqual(['1', '0'])
        const writesBefore = orderWrites().length

        // Another Tabby window puts @1 back in front.
        tmux!.windowOptions.get('@1')!.set('@tomux-order', '0')
        tmux!.windowOptions.get('@2')!.set('@tomux-order', '1')
        app.tabsChanged$.next()
        await vi.advanceTimersByTimeAsync(15000)
        await settle()

        expect(recordedOrder('@1', '@2')).toEqual(['0', '1'])
        expect(orderWrites()).toHaveLength(writesBefore)
    })

    it('writes its whole order when its tab bar changes after another client wrote', async () => {
        const service = makeService()
        await connect(service, tomuxProfile(), ['@1|0|%1|1|1||bash', '@2|1|%2|0|1||bash', '@3|2|%3|0|1||bash'])
        await vi.advanceTimersByTimeAsync(3000)
        await settle()
        expect(recordedOrder('@1', '@2', '@3')).toEqual(['0', '1', '2'])

        // Another Tabby window drags @3 to the front.
        tmux!.windowOptions.get('@3')!.set('@tomux-order', '0')
        tmux!.windowOptions.get('@1')!.set('@tomux-order', '1')
        tmux!.windowOptions.get('@2')!.set('@tomux-order', '2')
        // Then this one drags @2 to the front: @3 keeps position 2 here.
        dragToFront('@2')
        await vi.advanceTimersByTimeAsync(5000)
        await settle()

        expect(recordedOrder('@2', '@1', '@3')).toEqual(['0', '1', '2'])
    })
})
