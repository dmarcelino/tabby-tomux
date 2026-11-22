// SPDX-License-Identifier: GPL-3.0-only
/**
 * A native Tabby tab bound to one tmux window (design D3, D5, D6, D8, D9).
 *
 * It extends Tabby's SSHTabComponent so the first tab for a host gets Tabby's
 * own login flow (connection messages, host-key and password prompts) and
 * later tabs reuse the same SSH connection; only the session differs.
 */
import { Component, NgZone } from '@angular/core'
import { Subscription } from 'rxjs'
import { LogService, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { BindIntent, decideBinding } from '../binding'
import { TomuxPaneSession } from '../paneSession'
import type { TomuxProfile } from '../profile'
import { makeRecoveryToken } from '../recoveryToken'
import { sessionNameError } from '../sessionName'
import { SshControlTransport } from '../sshTransport'
import { loadTabbySsh } from '../tabbyAdapter'
import { TomuxConnection, TmuxVersionError } from '../tmux/connection'
import { connectionKey } from '../tmux/connectionRegistry'
import { CommandFlags, TmuxWindow } from '../tmux/controlClient'
import { pickTerminalTabTitle, TabTitleSync } from '../tmux/windowTitle'
import { ReservationKind } from '../reservations'
import { shouldShowRename } from '../titleEcho'
import { TomuxService } from '../tomux.service'

const { SSHTabComponent } = loadTabbySsh()

/** A tmux window this tab is bound to. `adopted`: it existed before, so show its history. */
type BoundWindow = Pick<TmuxWindow, 'id' | 'paneId' | 'index'> & Partial<Pick<TmuxWindow, 'name' | 'automaticRename'>> & { adopted: boolean }

/** Debounce for pushing the tab size to tmux (tmux-integrated uses 100 ms). */
const RESIZE_DEBOUNCE_MS = 100

@Component({
    selector: 'tomux-tab',
    template: `${BaseTerminalTabComponent.template}
<div class="tomux-ki bg-dark p-3" *ngIf="activeKIPrompt" (click)="$event.stopPropagation()">
  <div class="mb-2" *ngIf="activeKIPrompt.instruction">{{ activeKIPrompt.instruction }}</div>
  <label class="mb-2">{{ activeKIPrompt.prompts[kiStep]?.prompt }}</label>
  <input #kiInput class="form-control" autofocus
    [type]="activeKIPrompt.prompts[kiStep]?.echo ? 'text' : 'password'"
    (keyup.enter)="kiSubmit(kiInput.value); kiInput.value = ''">
</div>`,
    styles: [...BaseTerminalTabComponent.styles, '.tomux-ki { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5; }'],
    animations: BaseTerminalTabComponent.animations,
})
export class TomuxTabComponent extends SSHTabComponent {
    /** Inputs (set by TomuxService.tabInputs). `profile` is the SSH profile. */
    tomuxProfile!: TomuxProfile
    tomuxIntent: BindIntent = { kind: 'new' }
    tomuxError?: string
    /** Session from a recovery token; wins over the profile's current setting. */
    tomuxSessionName?: string

    enableToolbar = false
    disableDynamicTitle = true
    kiStep = 0

    /** The tmux window this tab shows, once bound (kept while reconnecting). */
    windowId: string | null = null

    private tomux!: TomuxService
    private connection: TomuxConnection | null = null
    private connectionKeyValue: string | null = null
    private paneSession: TomuxPaneSession | null = null
    private titleSync = new TabTitleSync()
    private resizeTimer: ReturnType<typeof setTimeout> | null = null
    private lastSize: { columns: number, rows: number } | null = null
    private tomuxSubs: Subscription[] = []
    private referenceHeld = false
    /** Set once the tab is destroyed; every await in initializeSession checks it (review item 2). */
    private disposed = false
    private closedByUser = false
    /** Connection key for this tab's reservations; null without a usable SSH profile. */
    private reservationKey: string | null = null
    private reservedWindows = new Set<string>()

    ngOnInit (): void {
        this.tomux = this.injector.get(TomuxService)
        void this.sessionName // pin the session name now
        super.ngOnInit()
        this.destroyed$.subscribe({
            // Read the close intent synchronously: Tabby clears it right after.
            next: () => this.onDestroyed(this.tomux.closeIntent.isInstalled && this.tomux.closeIntent.isUserClose(this)),
            complete: () => this.onDestroyed(false),
        })
        this.subscribeUntilDestroyed(this.focused$, () => this.onFocused())
        this.watchTabbyRename()
        if (this.profile?.options?.host) {
            this.reservationKey = connectionKey(this.profile as any, this.sessionName)
        }
        // Reserve the window now: Tabby only starts this tab's session when it
        // is first shown, and until then its window must not look unclaimed.
        if (this.tomuxIntent.kind !== 'new') {
            this.reserve(this.tomuxIntent.windowId, this.tomuxIntent.kind === 'adopt' ? 'restore' : 'reopen')
        }
    }

    /** Called by TomuxService when the window this restored tab reserved no longer exists. */
    onReservedWindowGone (): void {
        if (!this.connection && this.tomuxIntent.kind === 'adopt') {
            this.releaseReservations()
            this.closeQuietly(`tmux window ${this.tomuxIntent.windowId} no longer exists`)
        }
    }

    /**
     * Fixed when the tab is created: editing the tomux profile later must not
     * move an open tab (or its saved recovery token) to another session.
     */
    private sessionNameValue: string | null = null

    get sessionName (): string {
        if (this.sessionNameValue === null) {
            this.sessionNameValue = String(this.tomuxSessionName ?? this.tomuxProfile?.options?.sessionName ?? '')
        }
        return this.sessionNameValue
    }

    kiSubmit (value: string): void {
        const prompt = this.activeKIPrompt
        if (!prompt) {
            return
        }
        prompt.responses[this.kiStep] = value
        if (this.kiStep < prompt.prompts.length - 1) {
            this.kiStep++
            return
        }
        this.kiStep = 0
        prompt.respond()
        this.activeKIPrompt = null
    }

    async initializeSession (): Promise<void> {
        // Keep the connectable base behaviour, skip SSHTabComponent's own shell.
        await ConnectableTerminalTabComponent.prototype.initializeSession.call(this)
        if (this.windowId) {
            // Reconnecting: come back to the same window, or close if it is gone.
            this.tomuxIntent = { kind: 'adopt', windowId: this.windowId }
        }
        this.releaseConnection()
        if (this.disposed) {
            return
        }

        if (this.tomuxError) {
            this.writeError(this.tomuxError)
            return
        }
        const nameError = sessionNameError(this.sessionName)
        if (nameError) {
            this.writeError(nameError)
            return
        }

        try {
            this.sshSession = await this.setupOneSession(this.injector, this.profile)
        } catch (error) {
            if (!this.disposed) {
                this.writeError(`Could not connect: ${error}`)
            }
            return
        }
        if (this.disposed) {
            return
        }

        const sshSession = this.sshSession!
        const key = connectionKey(this.profile as any, this.sessionName)
        let acquired: { conn: TomuxConnection, opened: boolean }
        try {
            acquired = await this.tomux.acquire(
                key,
                () => TomuxConnection.open(new SshControlTransport(sshSession as any), this.sessionName),
                { tomuxProfile: this.tomuxProfile, sshProfile: this.profile },
            )
        } catch (error) {
            if (!this.disposed) {
                this.writeError(error instanceof TmuxVersionError ? error.message : `Could not start tmux: ${error}`)
            }
            return
        }
        if (this.disposed) {
            // Closed while connecting: give the reference straight back.
            this.tomux.releaseRef(key)
            return
        }
        const conn = acquired.conn
        this.connection = conn
        this.connectionKeyValue = key
        this.referenceHeld = true

        this.tomux.beginBind(conn)
        let window: BoundWindow | null
        try {
            window = await this.bind(conn, acquired.opened)
        } catch (error) {
            if (!this.disposed) {
                this.writeError(`Could not attach to a tmux window: ${error}`)
            }
            return
        } finally {
            this.tomux.endBind(conn)
        }
        if (!window || this.disposed) {
            return
        }

        // Start holding the pane's output right away, before any other round
        // trip, so a new window's first prompt is not lost (review item 3).
        const session = new TomuxPaneSession(
            this.injector.get(LogService).create(`tomux-${window.id}`),
            conn,
            window.paneId,
            (columns, rows) => this.onSessionResize(columns, rows),
        )
        this.paneSession = session
        this.setSession(session)
        this.watchConnection(conn)
        await this.settleTitle(conn, window)
        // Size tmux to this tab before capturing, so wrapped lines match.
        if (this.size?.columns && this.size?.rows) {
            this.lastSize = { columns: this.size.columns, rows: this.size.rows }
            await conn.client.refreshClient(this.size.columns, this.size.rows).catch(() => null)
        }
        if (this.disposed) {
            return
        }
        await session.start({ adopt: window.adopted })
        session.releaseInitialDataBuffer()
        if (this.hasFocus) {
            void conn.client.selectWindow(window.id).catch(() => null)
        }
    }

    async getRecoveryToken (options?: { includeState?: boolean }): Promise<RecoveryToken> {
        return makeRecoveryToken({
            tomuxProfileId: this.tomuxProfile?.id ?? '',
            sessionName: this.sessionName,
            windowId: this.windowId,
            includeState: !!options?.includeState,
            userClosed: !!this.tomux?.closeIntent.isUserClose(this),
        }) as unknown as RecoveryToken
    }

    /** Closing a tomux tab never needs SSH's "Disconnect from host?" question. */
    async canClose (): Promise<boolean> {
        return true
    }

    // ---- binding ---------------------------------------------------------

    /**
     * Decides and claims the window to show. Sets `windowId` the moment a
     * window is claimed, so a destroy that happens meanwhile releases it.
     */
    private async bind (conn: TomuxConnection, openedConnection: boolean): Promise<BoundWindow | null> {
        // Only the tab whose request opened the connection may take an existing
        // window for a `new` intent (review item 14).
        const firstBind = this.tomuxIntent.kind === 'new' && openedConnection
        for (let attempt = 0; attempt < 3; attempt++) {
            const windows = await conn.client.listWindows()
            if (this.disposed) {
                return null
            }
            const decision = decideBinding({
                intent: this.tomuxIntent,
                windows,
                isOwned: id => (!!conn.ownerOf(id) && conn.ownerOf(id) !== this)
                    || this.tomux.reservations.isReservedByOther(this.connectionKeyValue!, id, this),
                firstBind,
            })
            if (decision.action === 'close') {
                this.releaseReservations()
                this.closeQuietly(decision.reason)
                return null
            }
            if (decision.action === 'bind') {
                if (conn.claim(decision.window.id, this)) {
                    this.onBound(decision.window.id)
                    return { ...decision.window, adopted: true }
                }
                continue // claimed by another tab meanwhile; decide again
            }
            const created = await this.tomux.trackCreation(conn, (async () => {
                const w = await conn.client.newWindow()
                if (this.disposed) {
                    // Closed while the window was being created. If the user
                    // closed it, nobody ever saw this window: remove it.
                    // Otherwise leave it for adoption next time.
                    if (this.closedByUser) {
                        this.injector.get(LogService).create('tomux').info(`Killing tmux window ${w.windowId}: created for a tab the user closed while it was connecting`)
                        void conn.client.killWindow(w.windowId, CommandFlags.TolerateErrors).catch(() => null)
                    }
                    return null
                }
                // Review item 18: honour a failed claim instead of sharing the window.
                return conn.claim(w.windowId, this) ? w : null
            })())
            if (this.disposed) {
                return null
            }
            if (created) {
                this.onBound(created.windowId)
                return { id: created.windowId, paneId: created.paneId, index: created.windowIndex, adopted: false }
            }
        }
        this.releaseReservations()
        this.closeQuietly('could not claim a tmux window')
        return null
    }

    /** Bound: keep the window reserved for as long as this tab lives (review item 10). */
    private onBound (windowId: string): void {
        this.windowId = windowId
        for (const id of [...this.reservedWindows]) {
            if (id !== windowId) {
                this.releaseReservation(id)
            }
        }
        this.reserve(windowId, 'bound')
    }

    // ---- connection events ------------------------------------------------

    private watchConnection (conn: TomuxConnection): void {
        this.tomuxSubs.push(conn.events$.subscribe(event => {
            if (event.type === 'window-close' && event.windowId === this.windowId) {
                // tmux already removed the window: close the tab, send nothing more.
                this.releaseReservations()
                this.windowId = null
                this.closeQuietly()
            } else if (event.type === 'window-renamed' && event.windowId === this.windowId) {
                this.onWindowRenamed(event.name)
            } else if (event.type === 'window-pane-changed' && event.windowId === this.windowId) {
                this.paneSession?.switchPane(event.paneId)
            }
        }))
        void conn.closed.then(state => {
            if (this.connection !== conn || this.disposed) {
                return // this tab let go of the connection itself
            }
            if (state === 'exited') {
                // The session ended (or tmux moved us to another session).
                this.closeQuietly()
                return
            }
            // 'lost', or 'released' by someone else (e.g. the registry replaced a
            // connection that stopped answering): show it and let Tabby offer
            // reconnecting, which comes back to the same window (review items 4, 11).
            this.write('\r\n\x1b[30;43m tomux \x1b[0m Lost the connection to tmux. The tmux window is still running on the host.\r\n')
            void this.paneSession?.destroy()
        })
    }

    // ---- titles (design D9) ----------------------------------------------

    private async settleTitle (conn: TomuxConnection, window: BoundWindow): Promise<void> {
        const label = pickTerminalTabTitle(window.name, window.index, window.automaticRename, false)
        this.emitTitle(label)
        if (window.automaticRename !== false || (window.name ?? '') !== label) {
            this.titleSync.recordRenameSentToTmux(label)
            await conn.client.renameWindow(window.id, label).catch(() => null)
        }
    }

    private onWindowRenamed (name: string): void {
        if (shouldShowRename(this.titleSync, name)) {
            this.emitTitle(name)
        }
    }

    private emitTitle (title: string): void {
        const t = title.trim()
        if (!t || t === this.titleSync.lastEmittedTitle) {
            return
        }
        this.titleSync.recordEmission(t)
        this.setTitle(t)
    }

    /**
     * Tabby's "Rename tab" sets a custom title on the top-level tab (usually
     * the split container around us). Push such a rename to tmux and drop the
     * custom title, so the tab keeps following the tmux window name. In a
     * split only the focused pane handles it (review item 16).
     */
    private watchTabbyRename (): void {
        const top = (this as any).topmostParent ?? this
        this.subscribeUntilDestroyed(top.titleChange$, () => {
            const custom: string = (top.customTitle ?? '').trim()
            if (!custom || !this.connection || !this.windowId) {
                return
            }
            if (top !== this && top.focusedTab !== undefined && top.focusedTab !== this) {
                return
            }
            if (this.titleSync.classifyTerminalName(custom) !== 'user-rename') {
                return
            }
            const conn = this.connection
            const windowId = this.windowId
            this.titleSync.recordRenameSentToTmux(custom)
            this.emitTitle(custom)
            top.setCustomTitle('')
            void conn.client.renameWindow(windowId, custom).catch(() => null)
        })
    }

    // ---- size and focus ----------------------------------------------------

    private onSessionResize (columns: number, rows: number): void {
        this.lastSize = { columns, rows }
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer)
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null
            // One client size per connection: the focused tab's size wins.
            if (this.connection && this.lastSize && this.hasFocus) {
                void this.connection.client.refreshClient(this.lastSize.columns, this.lastSize.rows).catch(() => null)
            }
        }, RESIZE_DEBOUNCE_MS)
    }

    private onFocused (): void {
        const conn = this.connection
        if (!conn || !this.windowId) {
            return
        }
        void conn.client.selectWindow(this.windowId).catch(() => null)
        if (this.lastSize) {
            void conn.client.refreshClient(this.lastSize.columns, this.lastSize.rows).catch(() => null)
        }
    }

    // ---- teardown (design D6) ---------------------------------------------

    private onDestroyed (userClosed: boolean): void {
        // Called twice (destroyed$ next, then complete); only the first counts.
        if (this.disposed) {
            return
        }
        this.disposed = true
        this.closedByUser = userClosed
        const conn = this.connection
        const windowId = this.windowId
        if (userClosed && conn && windowId && conn.ownerOf(windowId) === this && conn.isLive) {
            this.injector.get(LogService).create('tomux').info(`Killing tmux window ${windowId} of session "${this.sessionName}": the user closed its tab`)
            void conn.client.killWindow(windowId, CommandFlags.TolerateErrors).catch(() => null)
        }
        this.releaseReservations()
        this.releaseConnection()
    }

    private reserve (windowId: string, kind: ReservationKind): void {
        if (this.reservationKey && this.tomux.reservations.reserve(this.reservationKey, windowId, this, kind)) {
            this.reservedWindows.add(windowId)
        }
    }

    private releaseReservation (windowId: string): void {
        if (this.reservationKey) {
            this.tomux.reservations.release(this.reservationKey, windowId, this)
        }
        this.reservedWindows.delete(windowId)
    }

    private releaseReservations (): void {
        for (const id of [...this.reservedWindows]) {
            this.releaseReservation(id)
        }
    }

    private releaseConnection (): void {
        this.tomuxSubs.forEach(s => s.unsubscribe())
        this.tomuxSubs = []
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer)
            this.resizeTimer = null
        }
        const conn = this.connection
        if (conn && this.windowId) {
            conn.release(this.windowId, this)
        }
        if (this.referenceHeld && this.connectionKeyValue) {
            this.referenceHeld = false
            this.tomux.releaseRef(this.connectionKeyValue)
        }
        this.connection = null
    }

    private closeQuietly (reason?: string): void {
        if (reason) {
            this.injector.get(LogService).create('tomux').info(`Closing tab: ${reason}`)
        }
        // Not a user close, so onDestroyed() will not kill anything.
        setTimeout(() => this.injector.get(NgZone).run(() => this.destroy()))
    }

    private writeError (message: string): void {
        this.write(`\r\n\x1b[30;41m tomux \x1b[0m ${message}\r\n`)
    }
}
