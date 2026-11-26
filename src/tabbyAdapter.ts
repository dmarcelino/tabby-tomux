// SPDX-License-Identifier: GPL-3.0-only
/**
 * The single place where tomux reaches into Tabby APIs that are not part of
 * a shared module or are marked @hidden. When a Tabby update breaks tomux,
 * this file is where to look first.
 *
 * Why tabby-ssh is loaded by path: Tabby shares its own instances of
 * @angular/*, rxjs, tabby-core, tabby-local, tabby-settings and
 * tabby-terminal with plugins, but not tabby-ssh. A plain require('tabby-ssh')
 * would resolve through Node's normal lookup and could find a second copy
 * (for example this repo's devDependency), whose classes are not the ones
 * Tabby's dependency injection knows. Tabby puts its built-in plugins folder
 * on Node's global module paths, so we load tabby-ssh from there by absolute
 * path; Node's module cache then returns the instance Tabby already loaded.
 *
 * Tabby internals tomux depends on (change add-ssh-toolbar, design T6):
 * - `SSHTabComponent` (runtime export) and its members `setupOneSession()`,
 *   `sshSession`, `activeKIPrompt`, `enableToolbar`, `openSFTP()`,
 *   `showPortForwarding()`, `reconnect()`, `onClick()`, `sftpPanelVisible`,
 *   `sftpPath` and `Platform`;
 * - `SFTPPanelComponent` (runtime export), created in code by
 *   `createSftpPanel()` because `SSHModule` doesn't export its element.
 *   `installSftpPanelAccessor()` and `openSftpPanelForTab()` are the only
 *   code that redefines `sftpPanelVisible` or reads and writes `sftpPath`
 *   and `sshSession` for it; the tab's template binds the inherited
 *   `reconnect()`, `openSFTP()`, `showPortForwarding()` and `Platform`
 *   exactly as tabby-ssh's own SSH tab template does;
 * - `SSHMultiplexerService.getSession()` and the `SSHSession` and russh
 *   members listed in sshTransport.ts.
 *
 * Tabby internals tomux depends on (change support-trzsz, design decision 2):
 * - `BaseSession`'s protected `output` and `binaryOutput` subjects, which
 *   carry what the tab shows once the session middleware has run. Only
 *   `showPastSessionMiddleware()` touches them.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Injector, NgZone, Type, ViewContainerRef } from '@angular/core'
import type { Subject, Subscription } from 'rxjs'
import type { BaseSession } from 'tabby-terminal'
import type * as TabbySsh from 'tabby-ssh'
import type { SSHTabComponent } from 'tabby-ssh/typings/components/sshTab.component'

/**
 * tabby-ssh's runtime exports. SSHTabComponent is exported at runtime since
 * Tabby 1.0.238 but missing from the newest published typings (1.0.231), so
 * its type comes from the declaration file directly.
 */
export type TabbySshModule = typeof TabbySsh & { SSHTabComponent: typeof SSHTabComponent }

// webpack replaces `require`; this is Node's real one, needed for runtime paths.
declare const __non_webpack_require__: NodeRequire

let cached: TabbySshModule | null = null

/** Returns Tabby's own, already-loaded tabby-ssh module. */
export function loadTabbySsh (): TabbySshModule {
    if (cached) {
        return cached
    }
    const Module = __non_webpack_require__('module')
    const searchPaths: string[] = Module.globalPaths ?? []
    for (const dir of searchPaths) {
        const candidate = path.join(dir, 'tabby-ssh')
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
            const mod = __non_webpack_require__(candidate) as TabbySshModule
            if (typeof mod.SSHTabComponent !== 'function' || typeof mod.SSHMultiplexerService !== 'function') {
                throw new Error('tomux: this Tabby version\'s tabby-ssh does not export SSHTabComponent and SSHMultiplexerService (needs Tabby 1.0.238 or newer)')
            }
            cached = mod
            return cached
        }
    }
    throw new Error('tomux: Tabby\'s tabby-ssh plugin was not found on the module search path')
}

/**
 * tabby-ssh's SFTP panel class, or null (after calling `warn`) when this
 * Tabby version doesn't export it. Without it tomux hides its SFTP button and
 * everything else keeps working.
 */
export function resolveSftpPanel (mod: Partial<TabbySshModule>, warn: (message: string) => void): Type<TabbySsh.SFTPPanelComponent> | null {
    const component = mod.SFTPPanelComponent
    if (typeof component === 'function') {
        return component as Type<TabbySsh.SFTPPanelComponent>
    }
    warn('This Tabby version\'s tabby-ssh does not export SFTPPanelComponent: the SFTP button is hidden in tomux tabs')
    return null
}

export interface SftpPanelOptions {
    /** The tab's SSHSession. */
    session: unknown
    /** Folder to start in. */
    path: string
    /** Play the slide animation (Tabby's accessibility.animations setting). */
    animate: boolean
    onPathChange: (path: string) => void
    onClosed: () => void
}

export interface SftpPanelHandle {
    /** Removes the panel (after its slide-out animation, if enabled). Safe to call twice. */
    destroy (): void
}

/**
 * Where the SSH tab's stylesheet puts `sftp-panel` (sshTab.component.scss).
 * No `display`: the panel's own `:host { display: flex }` must apply, or its
 * file list never gets a bounded height and can't scroll.
 */
export const SFTP_PANEL_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    height: '80%',
    width: '100%',
    left: '0',
    bottom: '0',
    zIndex: '5',
}

/** The SSH tab's `panelSlide` animation (tabby-terminal), replayed with the Web Animations API. */
const SLIDE_HIDDEN: Keyframe = { transform: 'translateY(25%)', opacity: 0 }
const SLIDE_SHOWN: Keyframe = { transform: 'translateY(0%)', opacity: 1 }
const SLIDE_TIMING: KeyframeAnimationOptions = { duration: 100, easing: 'ease-out' }

/**
 * Shows tabby-ssh's SFTP panel in `host`, as the SSH tab's template does with
 * `<sftp-panel>`. Angular gives a component created in code the template
 * scope of the module that declared it (SSHModule), so the panel's own pipes,
 * dropdowns and modals resolve without tomux importing them (spike, task 1).
 */
export function createSftpPanel (
    component: Type<TabbySsh.SFTPPanelComponent>,
    host: ViewContainerRef,
    injector: Injector,
    options: SftpPanelOptions,
): SftpPanelHandle {
    const ref = host.createComponent(component, { injector })
    ref.setInput('session', options.session)
    ref.setInput('path', options.path)
    ref.setInput('cwdDetectionAvailable', true)

    const element = ref.location.nativeElement as HTMLElement
    element.classList.add('bg-dark')
    Object.assign(element.style, SFTP_PANEL_STYLE)
    // The SSH tab closes the panel on any click in the tab; clicks inside the panel must not count.
    element.addEventListener('click', event => event.stopPropagation())

    const subscriptions: Subscription[] = [
        ref.instance.pathChange.subscribe(options.onPathChange),
        ref.instance.closed.subscribe(() => options.onClosed()),
    ]
    ref.changeDetectorRef.detectChanges()
    if (options.animate) {
        element.animate?.([SLIDE_HIDDEN, SLIDE_SHOWN], SLIDE_TIMING)
    }

    // Destroy inside Angular's zone: with Tabby's animation-aware renderer the
    // element is only removed at the next change detection, which code
    // running outside the zone (such as a connection-lost handler) never
    // triggers, so the panel would stay on screen.
    const zone = injector.get(NgZone)
    const destroyRef = (): void => zone.run(() => ref.destroy())

    let destroyed = false
    return {
        destroy: () => {
            if (destroyed) {
                return
            }
            destroyed = true
            subscriptions.forEach(s => s.unsubscribe())
            const animation = options.animate ? element.animate?.([SLIDE_SHOWN, SLIDE_HIDDEN], { ...SLIDE_TIMING, fill: 'forwards' }) : undefined
            if (!animation) {
                destroyRef()
                return
            }
            // Chromium barely advances animations while the window is in the
            // background, so never wait on the animation alone: a timer
            // removes the panel shortly after the slide should have ended.
            let removed = false
            const remove = (): void => {
                if (!removed) {
                    removed = true
                    destroyRef()
                }
            }
            animation.onfinish = remove
            animation.oncancel = remove
            setTimeout(remove, Number(SLIDE_TIMING.duration) + 50)
        },
    }
}

/** The `SSHTabComponent` members the SFTP panel uses (hidden in tabby-ssh). */
export interface SftpTabMembers {
    sshSession: { open?: boolean } | null
    /** The tab's terminal session (for tomux, the tmux pane). */
    session: { open: boolean } | null
    sftpPath: string
}

/**
 * Shows the SFTP panel for an SSH tab, as the SSH tab's template does, or
 * returns null when there is nothing to browse: no SSH session, a closed one,
 * or a tab whose session is not open (connecting, or the connection was lost).
 */
export function openSftpPanelForTab (
    tab: SftpTabMembers,
    component: Type<TabbySsh.SFTPPanelComponent>,
    host: ViewContainerRef,
    injector: Injector,
    options: { animate: boolean, onClosed: () => void },
): SftpPanelHandle | null {
    const sshSession = tab.sshSession
    if (!sshSession || sshSession.open === false || !tab.session?.open) {
        return null
    }
    return createSftpPanel(component, host, injector, {
        session: sshSession,
        path: tab.sftpPath,
        animate: options.animate,
        onPathChange: path => { tab.sftpPath = path },
        onClosed: options.onClosed,
    })
}

/** What `installSftpPanelAccessor` forwards `sftpPanelVisible` to. */
export interface SftpPanelVisibility {
    readonly visible: boolean
    set (visible: boolean): void
}

/**
 * Tabby shows and hides the SFTP panel only by assigning `sftpPanelVisible`
 * (from `openSFTP()`, `onClick()` and the panel's `closed` output).
 * `SSHTabComponent` declares it as a field, which TypeScript won't let a
 * subclass redeclare as an accessor, so this puts one on the subclass's
 * prototype. `SSHTabComponent`'s constructor assigns it before the
 * subclass's own fields exist, so `controlOf` must cope with that.
 */
export function installSftpPanelAccessor<T extends object> (cls: { prototype: T }, controlOf: (tab: T) => SftpPanelVisibility): void {
    Object.defineProperty(cls.prototype, 'sftpPanelVisible', {
        configurable: true,
        get (this: T): boolean {
            return controlOf(this).visible
        },
        set (this: T, visible: boolean) {
            controlOf(this).set(!!visible)
        },
    })
}

/**
 * If tabby-ssh was compiled with standard class fields, its constructor
 * defines `sftpPanelVisible` on the instance, hiding the prototype accessor
 * and with it the panel. Removes such an own property (calling `warn`) so
 * the accessor works again. Returns whether it had to.
 */
export function repairSftpPanelAccessor (tab: object, warn: (message: string) => void): boolean {
    if (!Object.prototype.hasOwnProperty.call(tab, 'sftpPanelVisible')) {
        return false
    }
    delete (tab as { sftpPanelVisible?: unknown }).sftpPanelVisible
    warn('tabby-ssh defines sftpPanelVisible on each tab; tomux removed it so its SFTP panel can open')
    return true
}

/** `BaseSession`'s protected output subjects (declared in tabby-terminal's typings). */
interface SessionOutputSubjects {
    output: Subject<string>
    binaryOutput: Subject<Buffer>
}

/**
 * Shows `data` in the session's tab without passing it through the session
 * middleware, the way `BaseSession` passes on what its middleware lets
 * through (`emitOutput` is the path through it). For text that is not new
 * output, such as history drawn again from tmux: plugins in the middleware,
 * tabby-trzsz among them, would otherwise react to it.
 *
 * It also skips `BaseSession`'s initial output buffer, so the tab must
 * already be subscribed to the session (Tabby's `setSession` does that).
 */
export function showPastSessionMiddleware (session: BaseSession, data: Buffer): void {
    const subjects = session as unknown as SessionOutputSubjects
    subjects.output.next(data.toString('utf-8'))
    subjects.binaryOutput.next(data)
}
