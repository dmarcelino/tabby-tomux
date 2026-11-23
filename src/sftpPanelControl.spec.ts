// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { SftpPanelControl } from './sftpPanelControl'

function stubPanel () {
    const destroyed: number[] = []
    let created = 0
    let canOpen = true
    const open = vi.fn(() => {
        if (!canOpen) {
            return null
        }
        const id = ++created
        return { destroy: () => { destroyed.push(id) } }
    })
    return { open, destroyed, setCanOpen: (v: boolean) => { canOpen = v }, get created () { return created } }
}

describe('SftpPanelControl', () => {
    it('starts hidden and opens a panel when set visible', () => {
        const stub = stubPanel()
        const control = new SftpPanelControl(stub.open)
        expect(control.visible).toBe(false)
        control.set(true)
        expect(control.visible).toBe(true)
        expect(stub.created).toBe(1)
    })

    it('stays hidden when the panel cannot be created yet (no view or no SSH session)', () => {
        const stub = stubPanel()
        stub.setCanOpen(false)
        const control = new SftpPanelControl(stub.open)
        control.set(true)
        expect(control.visible).toBe(false)
        // A later request opens it once creation is possible.
        stub.setCanOpen(true)
        control.set(true)
        expect(control.visible).toBe(true)
    })

    it('does not open a second panel when set visible twice', () => {
        const stub = stubPanel()
        const control = new SftpPanelControl(stub.open)
        control.set(true)
        control.set(true)
        expect(stub.open).toHaveBeenCalledTimes(1)
        expect(stub.created).toBe(1)
    })

    it('destroys the panel when set hidden, and opens a fresh one next time', () => {
        const stub = stubPanel()
        const control = new SftpPanelControl(stub.open)
        control.set(true)
        control.set(false)
        expect(control.visible).toBe(false)
        expect(stub.destroyed).toEqual([1])
        control.set(true)
        expect(stub.created).toBe(2)
    })

    it('ignores hide and close when no panel is shown', () => {
        const stub = stubPanel()
        const control = new SftpPanelControl(stub.open)
        control.set(false)
        control.close()
        expect(stub.destroyed).toEqual([])
        expect(stub.open).not.toHaveBeenCalled()
    })

    it('close() removes the panel (tab destroyed or session closed) and only once', () => {
        const stub = stubPanel()
        const control = new SftpPanelControl(stub.open)
        control.set(true)
        control.close()
        control.close()
        expect(stub.destroyed).toEqual([1])
        expect(control.visible).toBe(false)
    })
})
