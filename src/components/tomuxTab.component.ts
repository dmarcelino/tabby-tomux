// SPDX-License-Identifier: GPL-3.0-only
/**
 * A native Tabby tab bound to one tmux window (design D3, D5, D6, D8, D9).
 *
 * It extends Tabby's SSHTabComponent so the first tab for a host gets Tabby's
 * own login flow (connection messages, host-key and password prompts) and
 * later tabs reuse the same SSH connection; only the session differs.
 */
import { Component, NgZone, ViewChild, ViewContainerRef } from '@angular/core'
import { merge, Subscription } from 'rxjs'
import { Logger, LogService, NotificationsService, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { BindIntent, connectIntent, decideBinding, describeIntent } from '../binding'
import { followedTabWasReplaced } from '../followActiveTab'
import { TomuxPaneSession } from '../paneSession'
import { profileTabLook, TomuxProfile } from '../profile'
import { makeRecoveryToken } from '../recoveryToken'
import { sessionNameError } from '../sessionName'
import { connectionLogLine, withConnectContext } from '../connectionLog'
import { SshControlTransport, sshSessionNumber } from '../sshTransport'
import { installSftpPanelAccessor, loadTabbySsh, openSftpPanelForTab, repairSftpPanelAccessor, resolveSftpPanel, SftpPanelHandle } from '../tabbyAdapter'
import { SftpPanelControl } from '../sftpPanelControl'
import { SingleFlight } from '../singleFlight'
import { TomuxConnection, TmuxVersionError } from '../tmux/connection'
import { connectionKey } from '../tmux/connectionRegistry'
import { CommandFlags, TmuxWindow } from '../tmux/controlClient'
import { ReservationKind } from '../reservations'
import { describeScreen, ScreenLike } from '../screenReport'
import { customTitleAction, programTitleFromPane, TabTitleController } from '../tabTitle'
import { TomuxService, TomuxTabInputs } from '../tomux.service'

const tabbySsh = loadTabbySsh()
const { SSHTabComponent } = tabbySsh

/** A tmux window this tab is bound to. `adopted`: it existed before, so show its history. */
type BoundWindow = Pick<TmuxWindow, 'id' | 'paneId' | 'index'> & Partial<Pick<TmuxWindow, 'name' | 'automaticRename'>> & { adopted: boolean }

/** Debounce for pushing the tab size to tmux (tmux-integrated uses 100 ms). */
const RESIZE_DEBOUNCE_MS = 100

/** When to log what a restored tab's terminal shows (its output is written asynchronously). */
const RESTORE_REPORT_DELAY_MS = 2_000

@Component({
    selector: 'tomux-tab',
    // The <terminal-toolbar> block is copied from tabby-ssh's
    // src/components/sshTab.component.pug (Tabby 1.0.238), without its
    // working-directory tip: tomux always knows the pane's directory.
    // tabby-ssh doesn't export <sftp-panel>, so the panel is created in code
    // in #sftpHost (design T1, T2 of change add-ssh-toolbar).
    template: `${BaseTerminalTabComponent.template}
<terminal-toolbar [tab]="this">
  <i class="fas fa-xs fa-circle text-success me-2" *ngIf="session &amp;&amp; session.open"></i>
  <i class="fas fa-xs fa-circle text-danger me-2" *ngIf="!session || !session.open"></i>
  <strong class="me-auto" style="user-select: text; cursor: text;" onclick="event.stopPropagation()">{{profile.options.user}}@{{profile.options.host}}:{{profile.options.port}}<span class="ms-2 fw-normal text-muted" title="tmux session">{{sessionName}}</span></strong>
  <button class="btn btn-sm btn-link me-2" (click)="reconnect()"><i class="fas fa-redo"></i><span translate>Reconnect</span></button>
  <button class="btn btn-sm btn-link me-2" (click)="openSFTP()" *ngIf="sftpAvailable &amp;&amp; session &amp;&amp; session.open"><i class="far fa-folder-open"></i><span>SFTP</span></button>
  <button class="btn btn-sm btn-link" *ngIf="session &amp;&amp; session.open &amp;&amp; hostApp.platform !== Platform.Web" (click)="showPortForwarding()"><i class="fas fa-plug"></i><span translate>Ports</span></button>
</terminal-toolbar>
<ng-container #sftpHost></ng-container>
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
    /** Session from a recovery token or a followed tab; wins over the profile's current setting. */
    tomuxSessionName?: string
    /** Set when `+` followed the active tab (see followActiveTab.ts). */
    tomuxFollowed?: boolean
    /** The followed tab and its split; read once in ngOnInit (unfollowIfReplacing). */
    tomuxFollowedFrom?: TomuxTabInputs['tomuxFollowedFrom']
    /** Inputs of the profile that was asked for; read once in ngOnInit. */
    tomuxUnfollowed?: TomuxTabInputs

    enableToolbar = true
    /**
     * Always true, so Tabby's own handler never sets the title: program
     * titles go through `titles`, which gives a window name of the user's own
     * priority. The user's "Disable dynamic tab title" setting is read from
     * the tomux profile instead (show-app-titles, design decision 5).
     */
    disableDynamicTitle = true
    kiStep = 0

    /** The tmux window this tab shows, once bound (kept while reconnecting). */
    windowId: string | null = null

    private tomux!: TomuxService
    private connection: TomuxConnection | null = null
    private connectionKeyValue: string | null = null
    private paneSession: TomuxPaneSession | null = null
    private titles = new TabTitleController({
        showTitle: title => this.setTitle(title),
        renameWindow: async name => {
            if (this.connection && this.windowId) {
                await this.connection.client.renameWindow(this.windowId, name).catch(() => null)
            }
        },
        readProgramTitle: async paneId => {
            const pane = await this.connection?.client.getPaneTitle(paneId).catch(() => null)
            return pane ? programTitleFromPane(pane.title, pane.host) : null
        },
        dynamicTitles: () => !this.tomuxProfile?.disableDynamicTitle,
    })
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
    private tomuxLogger: Logger | null = null

    /** Where the SFTP panel is created; set once the view exists. */
    @ViewChild('sftpHost', { read: ViewContainerRef }) private sftpHost?: ViewContainerRef
    /** Created lazily: SSHTabComponent's constructor assigns sftpPanelVisible before our fields exist. */
    private sftpControlValue?: SftpPanelControl

    /** One connect at a time (see SingleFlight): Reconnect can be clicked again mid-connect. */
    private connectFlight = new SingleFlight()

    /** False when this Tabby's tabby-ssh doesn't export the SFTP panel; the SFTP button is then hidden. */
    get sftpAvailable (): boolean {
        return sftpPanelComponent(this.warnLater) !== null
    }

    /** Backs the sftpPanelVisible accessor installed below the class. */
    get sftpControl (): SftpPanelControl {
        this.sftpControlValue ??= new SftpPanelControl(() => this.createSftpPanel())
        return this.sftpControlValue
    }

    /** Logs a warning; the logger is created only when there is one. */
    private readonly warnLater = (message: string): void => this.tomuxLog.warn(message)

    private createSftpPanel (): SftpPanelHandle | null {
        if (!this.sftpHost || this.disposed) {
            return null // no view yet (SSHTabComponent's constructor) or already gone
        }
        const component = sftpPanelComponent(this.warnLater)
        if (!component) {
            // The toolbar hides SFTP, but Tabby's tab menu and hotkey still ask.
            this.injector.get(NotificationsService).error('SFTP is not available in tomux tabs with this Tabby version')
            return null
        }
        return openSftpPanelForTab(this, component, this.sftpHost, this.injector, {
            animate: !!this.config.store.accessibility?.animations,
            onClosed: () => { this.sftpPanelVisible = false },
        })
    }

    ngOnInit (): void {
        this.tomux = this.injector.get(TomuxService)
        this.unfollowIfReplacing()
        void this.sessionName // pin the session name now
        if (this.tomuxFollowed) {
            // Tabby gave this tab the default profile's title, colour and icon
            // after the provider returned; use those of the profile it opened on.
            const look = profileTabLook(this.tomuxProfile)
            this.setTitle(look.title)
            this.color = look.color
            this.icon = look.icon
        }
        repairSftpPanelAccessor(this, message => this.tomuxLog.warn(message))
        super.ngOnInit()
        this.destroyed$.subscribe({
            // Read the close intent synchronously: Tabby clears it right after.
            next: () => this.onDestroyed(this.tomux.closeIntent.isInstalled && this.tomux.closeIntent.isUserClose(this)),
            complete: () => this.onDestroyed(false),
        })
        this.subscribeUntilDestroyed(this.focused$, () => this.onFocused())
        this.watchProgramTitle()
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

    /**
     * Tabby's "Switch profile" to the default profile builds this tab through
     * the same path as `+`, so it followed the tab it now replaces. Open the
     * profile that was asked for instead (design D6). Runs before the session
     * name is pinned; drops the references either way.
     */
    private unfollowIfReplacing (): void {
        const from = this.tomuxFollowedFrom
        const unfollowed = this.tomuxUnfollowed
        this.tomuxFollowedFrom = undefined
        this.tomuxUnfollowed = undefined
        if (!this.tomuxFollowed || !from || !unfollowed || !followedTabWasReplaced(from.tab, from.container)) {
            return
        }
        this.profile = unfollowed.profile as any
        this.tomuxProfile = unfollowed.tomuxProfile
        this.tomuxIntent = unfollowed.tomuxIntent
        this.tomuxError = unfollowed.tomuxError
        this.tomuxSessionName = undefined
        this.tomuxFollowed = false
        this.tomuxLog.info('Switch profile: opening the requested profile, not the session of the tab being replaced')
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

    /**
     * Tabby calls this when the tab is first shown and on every reconnect.
     * A call made while a connect is running joins it (review: a double
     * click on Reconnect, or Tabby's reconnect-on-session-end firing from
     * inside reconnect(), must not connect twice).
     */
    initializeSession (): Promise<void> {
        return this.connectFlight.run(() => this.connect())
    }

    /**
     * tomux closes its tabs itself, on tmux's window-close and exit events.
     * Tabby's own rule (close when the profile says so, or after the user typed
     * `exit`) would close the tab when Reconnect or a lost connection ends the
     * pane session, leaving the tmux window without a tab.
     */
    shouldTabBeDestroyedOnSessionClose (): boolean {
        return false
    }

    private async connect (): Promise<void> {
        // Keep the connectable base behaviour, skip SSHTabComponent's own shell.
        await ConnectableTerminalTabComponent.prototype.initializeSession.call(this)
        // Reconnecting: come back to the same window, or close if it is gone.
        const reconnecting = this.windowId !== null
        this.tomuxIntent = connectIntent(this.tomuxIntent, this.windowId)
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
        // Which SSH session tmux runs on, to diagnose failures at startup. Tabs
        // share the connection the first tab opened, on that tab's session.
        const logContext = {
            sessionLabel: `SSH session #${sshSessionNumber(sshSession)}`,
            tabLabel: `tab ${describeIntent(this.tomuxIntent)}`,
        }
        let openedHere = false
        let acquired: { conn: TomuxConnection, opened: boolean }
        try {
            acquired = await this.tomux.acquire(
                key,
                () => {
                    openedHere = true
                    return TomuxConnection.open(new SshControlTransport(sshSession as any), this.sessionName, {
                        sessionLabel: logContext.sessionLabel,
                        warn: message => this.tomuxLog.warn(withConnectContext(message, logContext)),
                    })
                },
                { tomuxProfile: this.tomuxProfile, sshProfile: this.profile },
            )
            this.tomuxLog.info(connectionLogLine(acquired.opened
                ? { kind: 'opened' }
                : { kind: 'shared', connectionSession: acquired.conn.sessionLabel }, logContext))
        } catch (error) {
            this.tomuxLog.warn(connectionLogLine({ kind: 'failed', openedHere, error }, logContext))
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
        await this.settleTitle(window)
        if (window.adopted) {
            this.tomuxLog.info(`Restoring window ${window.id}: tab size ${formatSize(this.size)}, ${this.describeTerminalSize()}`)
        }
        // Size tmux to this tab before capturing, so wrapped lines match.
        if (this.size?.columns && this.size?.rows) {
            this.lastSize = { columns: this.size.columns, rows: this.size.rows }
            await this.sendClientSize(conn, this.lastSize, 'before capture')
        }
        if (this.disposed) {
            return
        }
        // A reconnecting tab already shows the old screen: draw it again from scratch.
        await session.start({ adopt: window.adopted, redraw: reconnecting })
        session.releaseInitialDataBuffer()
        if (this.hasFocus) {
            void conn.client.selectWindow(window.id).catch(() => null)
        }
        if (window.adopted) {
            const windowId = window.id
            setTimeout(() => this.reportRestoredScreen(windowId), RESTORE_REPORT_DELAY_MS)
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
                this.titles.onWindowRenamed(event.name)
            } else if (event.type === 'window-pane-changed' && event.windowId === this.windowId) {
                const session = this.paneSession
                session?.switchPane(event.paneId)
                void this.titles.onPaneChanged(event.paneId, !!session)
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
            // This runs outside Angular's zone: run it inside, or the toolbar
            // keeps showing the tab as connected until something else redraws.
            this.injector.get(NgZone).run(() => {
                this.write('\r\n\x1b[30;43m tomux \x1b[0m Lost the connection to tmux. The tmux window is still running on the host.\r\n')
                this.sftpControlValue?.close()
                void this.paneSession?.destroy()
            })
        })
    }

    // ---- titles (design D9; change show-app-titles) --------------------

    private async settleTitle (window: BoundWindow): Promise<void> {
        await this.titles.attach({ index: window.index, paneId: window.paneId, name: window.name, automaticRename: window.automaticRename })
    }

    /**
     * The title a program in the pane sets (OSC 0/2) reaches xterm through
     * %output. Show it as Tabby does for a local tab, subject to the
     * window-name precedence. Nothing is sent to tmux.
     */
    private watchProgramTitle (): void {
        if (!this.frontend) {
            return
        }
        const zone = this.injector.get(NgZone)
        this.subscribeUntilDestroyed(this.frontend.title$, title => zone.run(() => this.titles.onProgramTitle(title)))
    }

    /**
     * Tabby's "Rename tab" sets a custom title on the top-level tab (usually
     * the split container around us). Push such a rename to tmux and drop the
     * custom title, so the tab keeps following the tmux window name. In a
     * split only the focused pane handles it (review item 16).
     *
     * `titleChange$` drops a rename to the title the tab already shows (it is
     * `distinctUntilChanged`), which is how a user confirms a shown program
     * title to pin it. `setCustomTitle` always pings `recoveryStateChangedHint$`,
     * so listen to both. That hint also fires for unrelated split events
     * (adding, replacing or pinning tabs), so act only when the custom title
     * actually changed: a name a split keeps on purpose (renamed while another
     * pane was focused) is never pushed later by such an event.
     */
    private watchTabbyRename (): void {
        const top = (this as any).topmostParent ?? this
        let seen: string = top.customTitle ?? ''
        this.subscribeUntilDestroyed(merge(top.titleChange$, top.recoveryStateChangedHint$), () => {
            const current: string = top.customTitle ?? ''
            const previous = seen
            seen = current
            const panes: unknown[] = top !== this ? top.getAllTabs?.() ?? [this] : [this]
            const action = customTitleAction({
                previous,
                current,
                bound: !!this.connection && !!this.windowId,
                focused: top === this || top.focusedTab === undefined || top.focusedTab === this,
                paneCount: panes.length,
                containerTitle: top.title ?? '',
            })
            if (action === 'rename') {
                this.titles.onTabbyRename(current)
            }
            if (action !== 'ignore') {
                top.setCustomTitle('')
            }
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
                void this.sendClientSize(this.connection, this.lastSize, 'tab resized')
            } else if (this.lastSize) {
                this.tomuxLog.info(`Window ${this.windowId}: tab resized to ${formatSize(this.lastSize)}, not sent to tmux (${this.connection ? 'tab not focused' : 'not connected'})`)
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
            void this.sendClientSize(conn, this.lastSize, 'tab focused')
        }
    }

    private async sendClientSize (conn: TomuxConnection, size: { columns: number, rows: number }, reason: string): Promise<void> {
        this.tomuxLog.info(`Window ${this.windowId}: sizing the tmux client to ${formatSize(size)} (${reason}; ${this.describeTerminalSize()})`)
        await conn.client.refreshClient(size.columns, size.rows).catch(() => null)
    }

    // ---- diagnostics -------------------------------------------------------

    private get tomuxLog (): Logger {
        this.tomuxLogger ??= this.injector.get(LogService).create('tomux-tab')
        return this.tomuxLogger
    }

    private get screen (): ScreenLike | null {
        return (this.frontend as unknown as { xterm?: ScreenLike } | undefined)?.xterm ?? null
    }

    private describeTerminalSize (): string {
        const screen = this.screen
        return screen ? `terminal ${screen.cols}x${screen.rows}` : 'no terminal yet'
    }

    private reportRestoredScreen (windowId: string): void {
        const screen = this.screen
        if (!this.disposed && screen) {
            this.tomuxLog.info(`Window ${windowId} ${RESTORE_REPORT_DELAY_MS} ms after restore: ${describeScreen(screen)}`)
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
        this.sftpControlValue?.close()
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
        this.sftpControlValue?.close()
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

// SSHTabComponent's constructor assigns sftpPanelVisible before the tab's
// fields exist; the control is created lazily and opens nothing then, because
// there is no view yet.
installSftpPanelAccessor(TomuxTabComponent, tab => tab.sftpControl)

let sftpPanelResolved = false
let sftpPanelClass: ReturnType<typeof resolveSftpPanel> = null

/** tabby-ssh's SFTPPanelComponent, looked up once (it logs a warning once when missing). */
function sftpPanelComponent (warn: (message: string) => void): ReturnType<typeof resolveSftpPanel> {
    if (!sftpPanelResolved) {
        sftpPanelResolved = true
        sftpPanelClass = resolveSftpPanel(tabbySsh, warn)
    }
    return sftpPanelClass
}

function formatSize (size: { columns: number, rows: number } | null | undefined): string {
    return size ? `${size.columns}x${size.rows}` : 'unknown'
}
