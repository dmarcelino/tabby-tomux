// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Subject } from 'rxjs'
import {
    createSftpPanel,
    installSftpPanelAccessor,
    openSftpPanelForTab,
    repairSftpPanelAccessor,
    resolveSftpPanel,
    SFTP_PANEL_STYLE,
    SftpPanelOptions,
    showPastSessionMiddleware,
} from './tabbyAdapter'

afterEach(() => {
    vi.useRealTimers()
})

describe('resolveSftpPanel', () => {
    it('returns tabby-ssh\'s SFTPPanelComponent when it is exported', () => {
        class SFTPPanelComponent {}
        const warn = vi.fn()
        expect(resolveSftpPanel({ SFTPPanelComponent } as any, warn)).toBe(SFTPPanelComponent)
        expect(warn).not.toHaveBeenCalled()
    })

    it('returns null and warns, without throwing, when the export is missing', () => {
        const warn = vi.fn()
        expect(resolveSftpPanel({}, warn)).toBeNull()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toContain('SFTPPanelComponent')
    })
})

/** A fake animation whose end the test triggers (or never triggers). */
class FakeAnimation {
    onfinish: (() => void) | null = null
    oncancel: (() => void) | null = null
    finish (): void { this.onfinish?.() }
}

/** Fakes for the Angular objects createSftpPanel touches, without a browser. */
function fakes () {
    const animations: Array<{ keyframes: any[], timing: any, animation: FakeAnimation }> = []
    let clickHandler: ((event: { stopPropagation: () => void }) => void) | null = null
    const element = {
        classList: { added: [] as string[], add (c: string) { this.added.push(c) } },
        style: {} as Record<string, string>,
        addEventListener: (type: string, handler: any) => { if (type === 'click') clickHandler = handler },
        animate: (keyframes: any[], timing: any) => {
            const animation = new FakeAnimation()
            animations.push({ keyframes, timing, animation })
            return animation
        },
    }
    const instance = { pathChange: new Subject<string>(), closed: new Subject<void>() }
    const inputs: Record<string, unknown> = {}
    const ref = {
        instance,
        location: { nativeElement: element },
        setInput: (name: string, value: unknown) => { inputs[name] = value },
        changeDetectorRef: { detectChanges: vi.fn() },
        destroy: vi.fn(),
    }
    const zone = { inZone: false, run: vi.fn((fn: () => unknown) => { zone.inZone = true; try { return fn() } finally { zone.inZone = false } }) }
    ref.destroy.mockImplementation(() => { destroyedInZone.push(zone.inZone) })
    const destroyedInZone: boolean[] = []
    const host = { createComponent: vi.fn(() => ref) }
    const injector = { get: () => zone }
    const click = () => {
        const event = { stopPropagation: vi.fn() }
        clickHandler?.(event)
        return event
    }
    return { element, instance, inputs, ref, zone, host, injector, animations, click, destroyedInZone }
}

function options (overrides: Partial<SftpPanelOptions> = {}): SftpPanelOptions {
    return { session: { id: 'ssh' }, path: '/var/log', animate: false, onPathChange: vi.fn(), onClosed: vi.fn(), ...overrides }
}

const Panel = class {} as any

describe('createSftpPanel', () => {
    it('creates the panel with the session, path and cwd detection, styled like the SSH tab\'s', () => {
        const f = fakes()
        createSftpPanel(Panel, f.host as any, f.injector as any, options())
        expect(f.host.createComponent).toHaveBeenCalledWith(Panel, { injector: f.injector })
        expect(f.inputs).toEqual({ session: { id: 'ssh' }, path: '/var/log', cwdDetectionAvailable: true })
        expect(f.element.classList.added).toContain('bg-dark')
        expect(f.element.style).toMatchObject(SFTP_PANEL_STYLE)
        expect(f.ref.changeDetectorRef.detectChanges).toHaveBeenCalled()
    })

    it('leaves display to the panel\'s own flex layout, so its file list can scroll', () => {
        const f = fakes()
        createSftpPanel(Panel, f.host as any, f.injector as any, options())
        expect(f.element.style.display).toBeUndefined()
    })

    it('stops clicks inside the panel from reaching the tab', () => {
        const f = fakes()
        createSftpPanel(Panel, f.host as any, f.injector as any, options())
        expect(f.click().stopPropagation).toHaveBeenCalled()
    })

    it('passes the panel\'s path changes and close requests on', () => {
        const f = fakes()
        const opts = options()
        createSftpPanel(Panel, f.host as any, f.injector as any, opts)
        f.instance.pathChange.next('/etc')
        f.instance.closed.next()
        expect(opts.onPathChange).toHaveBeenCalledWith('/etc')
        expect(opts.onClosed).toHaveBeenCalledTimes(1)
    })

    it('without animation, destroy removes the panel at once, inside Angular\'s zone, only once', () => {
        const f = fakes()
        const handle = createSftpPanel(Panel, f.host as any, f.injector as any, options())
        handle.destroy()
        handle.destroy()
        expect(f.ref.destroy).toHaveBeenCalledTimes(1)
        expect(f.destroyedInZone).toEqual([true])
        expect(f.animations).toHaveLength(0)
    })

    it('stops passing outputs on once destroyed', () => {
        const f = fakes()
        const opts = options()
        createSftpPanel(Panel, f.host as any, f.injector as any, opts).destroy()
        f.instance.closed.next()
        f.instance.pathChange.next('/tmp')
        expect(opts.onClosed).not.toHaveBeenCalled()
        expect(opts.onPathChange).not.toHaveBeenCalled()
    })

    it('with animation, slides in, and on destroy slides out and removes the panel when the slide ends', () => {
        vi.useFakeTimers()
        const f = fakes()
        const handle = createSftpPanel(Panel, f.host as any, f.injector as any, options({ animate: true }))
        expect(f.animations).toHaveLength(1)
        expect(f.animations[0].keyframes[0]).toMatchObject({ opacity: 0 })
        handle.destroy()
        expect(f.animations).toHaveLength(2)
        expect(f.ref.destroy).not.toHaveBeenCalled()
        f.animations[1].animation.finish()
        expect(f.ref.destroy).toHaveBeenCalledTimes(1)
        // The fallback timer must not destroy it a second time.
        vi.advanceTimersByTime(1000)
        expect(f.ref.destroy).toHaveBeenCalledTimes(1)
        expect(f.destroyedInZone).toEqual([true])
    })

    it('with animation, still removes the panel when the slide never ends (window in the background)', () => {
        vi.useFakeTimers()
        const f = fakes()
        const handle = createSftpPanel(Panel, f.host as any, f.injector as any, options({ animate: true }))
        handle.destroy()
        vi.advanceTimersByTime(149)
        expect(f.ref.destroy).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(f.ref.destroy).toHaveBeenCalledTimes(1)
        expect(f.destroyedInZone).toEqual([true])
    })
})

describe('openSftpPanelForTab', () => {
    const tab = (overrides: Record<string, unknown> = {}) => ({
        sshSession: { open: true },
        session: { open: true },
        sftpPath: '/srv',
        ...overrides,
    })
    const open = (t: ReturnType<typeof tab>) => {
        const f = fakes()
        const onClosed = vi.fn()
        const handle = openSftpPanelForTab(t as any, Panel, f.host as any, f.injector as any, { animate: false, onClosed })
        return { f, handle, onClosed }
    }

    it('returns null without an SSH session, with a closed one, or while the tab\'s session is not open', () => {
        expect(open(tab({ sshSession: null })).handle).toBeNull()
        expect(open(tab({ sshSession: { open: false } })).handle).toBeNull()
        expect(open(tab({ session: null })).handle).toBeNull()
        expect(open(tab({ session: { open: false } })).handle).toBeNull()
    })

    it('opens the panel at the tab\'s SFTP path and keeps that path up to date', () => {
        const t = tab()
        const { f, handle, onClosed } = open(t)
        expect(handle).not.toBeNull()
        expect(f.inputs.session).toBe(t.sshSession)
        expect(f.inputs.path).toBe('/srv')
        f.instance.pathChange.next('/srv/www')
        expect(t.sftpPath).toBe('/srv/www')
        f.instance.closed.next()
        expect(onClosed).toHaveBeenCalled()
    })
})

describe('installSftpPanelAccessor', () => {
    class Base {
        // `declare`: no class field, as in tabby-ssh's ES2017 build, where the
        // constructor's assignment is the only definition.
        declare sftpPanelVisible: boolean
        constructor () {
            this.sftpPanelVisible = false
        }
    }

    it('forwards assignments and reads of sftpPanelVisible to the tab\'s control, including the constructor\'s', () => {
        class Tab extends Base {}
        const sets: boolean[] = []
        installSftpPanelAccessor(Tab, () => ({ visible: sets[sets.length - 1] ?? false, set: (v: boolean) => { sets.push(v) } }))
        const t = new Tab()
        expect(sets).toEqual([false])
        t.sftpPanelVisible = true
        expect(sets).toEqual([false, true])
        expect(t.sftpPanelVisible).toBe(true)
        expect(Object.prototype.hasOwnProperty.call(t, 'sftpPanelVisible')).toBe(false)
    })
})

describe('installSftpPanelAccessor + repairSftpPanelAccessor', () => {
    it('makes the accessor work again when the base class defines sftpPanelVisible as a standard class field', () => {
        class FieldBase {
            sftpPanelVisible = false // define semantics: an own property on each instance
        }
        class Tab extends FieldBase {}
        let visible = false
        installSftpPanelAccessor(Tab, () => ({ get visible () { return visible }, set: (v: boolean) => { visible = v } }))
        const t = new Tab()
        t.sftpPanelVisible = true
        expect(visible).toBe(false) // hidden by the own property
        expect(repairSftpPanelAccessor(t, vi.fn())).toBe(true)
        t.sftpPanelVisible = true
        expect(visible).toBe(true)
    })
})

describe('repairSftpPanelAccessor', () => {
    it('removes an own sftpPanelVisible property hiding the accessor, and warns', () => {
        const proto = {}
        let visible = false
        Object.defineProperty(proto, 'sftpPanelVisible', { configurable: true, get: () => visible, set: (v: boolean) => { visible = v } })
        const t = Object.create(proto)
        Object.defineProperty(t, 'sftpPanelVisible', { value: false, writable: true, configurable: true, enumerable: true })
        const warn = vi.fn()
        expect(repairSftpPanelAccessor(t, warn)).toBe(true)
        expect(warn).toHaveBeenCalledTimes(1)
        t.sftpPanelVisible = true
        expect(visible).toBe(true)
    })

    it('does nothing when the accessor is not hidden', () => {
        const warn = vi.fn()
        expect(repairSftpPanelAccessor({}, warn)).toBe(false)
        expect(warn).not.toHaveBeenCalled()
    })
})

describe('showPastSessionMiddleware', () => {
    // Stands in for a BaseSession: Tabby feeds what its middleware lets
    // through to these two protected subjects, and the tab shows them.
    function fakeSession (): { session: any, text: string[], binary: Buffer[], middleware: Buffer[] } {
        const text: string[] = []
        const binary: Buffer[] = []
        const middleware: Buffer[] = []
        const output = new Subject<string>()
        const binaryOutput = new Subject<Buffer>()
        output.subscribe(t => text.push(t))
        binaryOutput.subscribe(b => binary.push(b))
        const session = {
            output,
            binaryOutput,
            middleware: { feedFromSession: (data: Buffer) => middleware.push(data) },
            emitOutput (data: Buffer) { this.middleware.feedFromSession(data) },
        }
        return { session, text, binary, middleware }
    }

    it('hands the data to both output subjects and not to the middleware', () => {
        const { session, text, binary, middleware } = fakeSession()
        showPastSessionMiddleware(session, Buffer.from('héllo\r\n', 'utf-8'))
        expect(text).toEqual(['héllo\r\n'])
        expect(binary.map(b => b.toString('utf-8'))).toEqual(['héllo\r\n'])
        expect(middleware).toEqual([])
    })
})
