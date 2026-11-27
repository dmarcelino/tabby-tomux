// SPDX-License-Identifier: GPL-3.0-only
/**
 * Glue between Tabby and the tomux core: one registry of control connections
 * per Tabby window, the close-intent tracker, the code that opens tabs
 * for tmux windows no tab has claimed (design D4, D5, D6), and the sync that
 * records the tab order in tmux (change restore-tab-order, design D5).
 */
import { Injectable, Injector, NgZone } from '@angular/core'
import { debounceTime, interval, merge, Subject, Subscription } from 'rxjs'
import { AppService, BaseTabComponent, Logger, LogService, PartialProfile, ProfilesService, SplitTabComponent } from 'tabby-core'
import { BindIntent } from './binding'
import { acquireTracked } from './acquire'
import { planAdoption, Reservations } from './reservations'
import { CloseIntentTracker } from './closeIntent'
import { profileTabLook, TabLook, TomuxProfile } from './profile'
import { TomuxConnection } from './tmux/connection'
import { ConnectionRegistry } from './tmux/connectionRegistry'
import { CommandFlags } from './tmux/controlClient'
import { compareByRecordedOrder, openInOrder, planOrderWrites } from './tabOrder'

/** How long after a connection opens before unclaimed windows get their own tabs. */
const ADOPTION_GRACE_MS = 2000
/** Upper bound on waiting for restored tabs to finish binding. */
const ADOPTION_MAX_WAIT_MS = 15000
/** Quiet time after a tab-bar change or a bind before the tab order is recorded in tmux. */
const ORDER_SYNC_DEBOUNCE_MS = 300
/**
 * Fallback check of the tab order: Tabby's move-tab hotkeys (swapTabs) don't
 * emit tabsChanged$. Only compares in memory unless the order changed.
 */
const ORDER_SYNC_INTERVAL_MS = 10000

interface ConnectionState {
    pendingBinds: number
    /** In-flight `new-window` calls by tomux tabs (claimed when they resolve). */
    creations: Set<Promise<unknown>>
    tomuxProfile: TomuxProfile
    sshProfile: PartialProfile<any>
    key: string
    /** Set once adoption has opened its tabs: only then may `@tomux-order` be written (design D5). */
    orderReady: boolean
    /** Each window's `@tomux-order` in tmux as far as tomux knows (read at adoption, then written). */
    written: Map<string, number>
}

export interface TomuxTabInputs {
    profile: PartialProfile<any>
    tomuxProfile: TomuxProfile
    tomuxIntent: BindIntent
    /** Set when the SSH profile the tomux profile points at no longer exists. */
    tomuxError?: string
    /** Session from a recovery token or a followed tab; wins over the profile's current setting. */
    tomuxSessionName?: string
    /** Set when `+` followed the active tab: the tab takes its look from tomuxProfile (followActiveTab.ts). */
    tomuxFollowed?: boolean
    /** The followed tab and the split that held it, to tell `+` from Tabby's "Switch profile". */
    tomuxFollowedFrom?: { tab: unknown, container: { getAllTabs (): unknown[] } | null }
    /** Inputs for the profile that was asked for, used when the followed tab turns out to be replaced. */
    tomuxUnfollowed?: TomuxTabInputs
}

@Injectable({ providedIn: 'root' })
export class TomuxService {
    readonly closeIntent = new CloseIntentTracker()
    readonly registry = new ConnectionRegistry()
    /** Set by the module at startup to avoid an import cycle with the tab component. */
    tabComponent: (new (...args: any[]) => BaseTabComponent) | null = null

    private logger: Logger
    private states = new WeakMap<TomuxConnection, ConnectionState>()
    /** Connections set up by this service and not yet ended, for the tab-order sync. */
    private connections = new Set<TomuxConnection>()
    private orderHint = new Subject<void>()
    private orderSync: Subscription | null = null

    /*
     * Tabby services are looked up lazily: ProfilesService and AppService
     * (through tab recovery) construct tomux's providers, which need this
     * service, so injecting them here would be a dependency cycle (Angular
     * then hands out an empty placeholder object instead of failing).
     */
    constructor (private injector: Injector, log: LogService) {
        this.logger = log.create('tomux')
    }

    private get app (): AppService { return this.injector.get(AppService) }
    private get zone (): NgZone { return this.injector.get(NgZone) }
    private get profiles (): ProfilesService { return this.injector.get(ProfilesService) }

    /** Called once by the module, after Tabby's services exist. */
    init (): void {
        if (!this.closeIntent.install(this.app as any)) {
            this.logger.warn('Could not wrap AppService.closeTab: closing tomux tabs will NOT kill tmux windows')
        }
    }

    /** Inputs for a TomuxTab, resolving the SSH profile the tomux profile points at. */
    async tabInputs (tomuxProfile: TomuxProfile, intent: BindIntent): Promise<TomuxTabInputs> {
        const id = tomuxProfile.options?.sshProfileId
        const ssh = id ? (await this.profiles.getProfiles()).find(p => p.id === id && p.type === 'ssh') : undefined
        if (ssh) {
            return { profile: this.profiles.getConfigProxyForProfile(ssh), tomuxProfile, tomuxIntent: intent }
        }
        // Keep the tab renderable with a harmless placeholder; it shows the error instead of connecting.
        const placeholder = this.profiles.getConfigProxyForProfile({ type: 'ssh', name: tomuxProfile.name, options: { host: '' } } as any)
        return {
            profile: placeholder,
            tomuxProfile,
            tomuxIntent: intent,
            tomuxError: id
                ? `The SSH profile this tomux profile uses (id "${id}") no longer exists. Edit the tomux profile and choose another one.`
                : 'This tomux profile has no SSH profile selected. Edit it and choose one.',
        }
    }

    /** Windows tabs intend to show, kept across reconnects (see reservations.ts). */
    readonly reservations = new Reservations()

    /**
     * Takes a reference on the connection for `key`, opening it if needed.
     * `opened` is true only for the caller whose request actually opened the
     * connection (concurrent callers share one attempt): only that tab may
     * take an existing window for a `new` intent (spec tomux-profile; review item 14).
     */
    async acquire (key: string, open: () => Promise<TomuxConnection>, ctx: { tomuxProfile: TomuxProfile, sshProfile: PartialProfile<any> }): Promise<{ conn: TomuxConnection, opened: boolean }> {
        const { conn, opened } = await acquireTracked(this.registry, key, open)
        if (!this.states.has(conn)) {
            this.setUpConnection(conn, { ...ctx, key })
        }
        return { conn, opened }
    }

    releaseRef (key: string): void {
        this.registry.releaseRef(key)
    }

    beginBind (conn: TomuxConnection): void {
        const state = this.states.get(conn)
        if (state) {
            state.pendingBinds++
        }
    }

    endBind (conn: TomuxConnection): void {
        const state = this.states.get(conn)
        if (state) {
            state.pendingBinds = Math.max(0, state.pendingBinds - 1)
        }
        // A tab bound (or failed to bind) a window: its position may need recording.
        this.hintOrder()
    }

    /** Wraps a tab's `new-window` + claim so `%window-add` handling can wait for it. */
    trackCreation<T> (conn: TomuxConnection, work: Promise<T>): Promise<T> {
        const state = this.states.get(conn)
        if (state) {
            state.creations.add(work)
            const done = () => state.creations.delete(work)
            work.then(done, done)
        }
        return work
    }

    private setUpConnection (conn: TomuxConnection, ctx: { tomuxProfile: TomuxProfile, sshProfile: PartialProfile<any>, key: string }): void {
        const state: ConnectionState = {
            pendingBinds: 0,
            creations: new Set(),
            tomuxProfile: ctx.tomuxProfile,
            sshProfile: ctx.sshProfile,
            key: ctx.key,
            orderReady: false,
            written: new Map(),
        }
        this.states.set(conn, state)

        conn.events$.subscribe(event => {
            if (event.type === 'window-add') {
                void this.onWindowAdd(conn, event.windowId)
            } else if (event.type === 'window-close') {
                state.written.delete(event.windowId)
            }
        })
        this.connections.add(conn)
        this.startOrderSync()
        void conn.closed.then(() => {
            this.connections.delete(conn)
            if (!this.connections.size) {
                this.stopOrderSync()
            }
        })
        void this.adoptLeftovers(conn)
    }

    /**
     * Records the order of this Tabby window's tabs in tmux while it has
     * connections (design D5): after tab-bar changes and binds, and on a slow
     * interval for the moves Tabby doesn't announce. Runs in every Tabby
     * window; when two show the same session, the last write wins (change
     * record-order-other-windows).
     */
    private startOrderSync (): void {
        if (this.orderSync) {
            return
        }
        const sync = new Subscription()
        sync.add(this.app.tabsChanged$.subscribe(() => this.hintOrder()))
        // The timers must start outside Angular's zone, or every run would
        // trigger change detection; hintOrder() hands events over to it.
        this.zone.runOutsideAngular(() => {
            sync.add(merge(
                this.orderHint.pipe(debounceTime(ORDER_SYNC_DEBOUNCE_MS)),
                interval(ORDER_SYNC_INTERVAL_MS),
            ).subscribe(() => this.syncOrder()))
        })
        this.orderSync = sync
    }

    /** Asks for a sync soon. Emits outside Angular's zone so the debounce timer starts there. */
    private hintOrder (): void {
        this.zone.runOutsideAngular(() => this.orderHint.next())
    }

    private stopOrderSync (): void {
        this.orderSync?.unsubscribe()
        this.orderSync = null
    }

    /** Sends the `@tomux-order` values that differ from the tab bar. */
    private syncOrder (): void {
        const bar = this.app.tabs.flatMap(tab => tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab])
        for (const conn of this.connections) {
            const state = this.states.get(conn)
            if (!state?.orderReady || !conn.isLive) {
                continue
            }
            // Reserved windows too: a restored or adopted tab connects only once shown.
            const windows = [
                ...conn.ownedWindows(),
                ...this.reservations.entries(state.key).map(r => [r.windowId, r.owner] as [string, object]),
            ]
            for (const [windowId, order] of planOrderWrites(bar, windows, state.written)) {
                // Recorded before tmux answers, so a refused write is not retried in a loop.
                state.written.set(windowId, order)
                void conn.client.setWindowOrder(windowId, order).catch(() => null)
            }
        }
    }

    /** After restored tabs had their chance, give every unclaimed window its own tab. */
    private async adoptLeftovers (conn: TomuxConnection): Promise<void> {
        const state = this.states.get(conn)!
        await sleep(ADOPTION_GRACE_MS)
        const deadline = Date.now() + ADOPTION_MAX_WAIT_MS
        while ((state.pendingBinds > 0 || state.creations.size > 0) && Date.now() < deadline && conn.isLive) {
            await sleep(200)
        }
        if (!conn.isLive) {
            return
        }
        const windows = await conn.client.listWindows().catch(() => null)
        if (!windows) {
            this.logger.warn(`Could not list the windows of session ${conn.sessionName}: no tabs opened for its other windows, and its tab order will not be recorded in tmux`)
            return
        }
        // Close restored tabs whose window was closed while Tabby was not
        // running (not reopened tabs: they create a new window instead), and
        // open a tab for every window nobody owns or reserved.
        const plan = planAdoption(windows.map(w => w.id), id => !!conn.ownerOf(id), this.reservations.entries(state.key))
        for (const owner of plan.close) {
            (owner as { onReservedWindowGone?: () => void }).onReservedWindowGone?.()
        }
        // What tmux has recorded, so the sync only sends changes. Writing starts
        // after the tabs below are open, never before this read (design D5).
        for (const w of windows) {
            if (w.order !== null) {
                state.written.set(w.id, w.order)
            }
        }
        // Prepare every tab at once, then add them to the tab bar in recorded
        // tab order (change restore-tab-order, design D4).
        const byId = new Map(windows.map(w => [w.id, w]))
        const ordered = plan.open
            .map(id => byId.get(id)!)
            .sort(compareByRecordedOrder)
            .map(w => w.id)
        try {
            const failures = await openInOrder(
                ordered,
                id => this.prepareAdoptTab(state, conn, id),
                (_id, inputs) => this.openAdoptTab(inputs),
                openAll => this.zone.run(openAll),
            )
            for (const { id, error } of failures) {
                this.logger.error(`Could not open a tab for tmux window ${id}:`, error)
            }
        } finally {
            state.orderReady = true
            this.hintOrder()
        }
    }

    /**
     * A window appeared. If a tomux tab is creating it, the tab claims it; we
     * wait for tmux to answer a no-op (it answers in order, so our own
     * new-window reply has been processed) and for in-flight creations,
     * then open a tab only if nobody claimed the window.
     */
    private async onWindowAdd (conn: TomuxConnection, windowId: string): Promise<void> {
        const state = this.states.get(conn)
        if (!state) {
            return
        }
        try {
            await conn.client.sendCommand('display-message -p ""', CommandFlags.TolerateErrors)
        } catch {
            return
        }
        await Promise.allSettled([...state.creations])
        if (conn.isLive && !conn.ownerOf(windowId) && !this.reservations.isReservedByOther(state.key, windowId)) {
            const inputs = await this.prepareAdoptTab(state, conn, windowId)
            this.zone.run(() => this.openAdoptTab(inputs))
        }
    }

    /**
     * Inputs for a tab that adopts `windowId` (async: looks up the SSH profile).
     * The tab gets the title, colour and icon Tabby gives a tab opened from
     * the tomux profile (change adopted-tab-profile-look, design D1).
     */
    private async prepareAdoptTab (state: ConnectionState, conn: TomuxConnection, windowId: string): Promise<TomuxTabInputs & TabLook> {
        const inputs = await this.tabInputs(state.tomuxProfile, { kind: 'adopt', windowId })
        inputs.tomuxSessionName = conn.sessionName
        return { ...inputs, ...profileTabLook(state.tomuxProfile) }
    }

    /** Adds an adopted tab at the end of the tab bar. Call inside Angular's zone, or the tab never renders (spike 2). */
    private openAdoptTab (inputs: TomuxTabInputs): void {
        const type = this.tabComponent
        if (type) {
            this.app.openNewTab({ type, inputs: inputs as any })
        }
    }
}

function sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
