// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { OutputGate } from './outputGate'

describe('OutputGate', () => {
    it('keeps a new window\'s first prompt that arrives before setup finishes (review item 3)', () => {
        const out: string[] = []
        const gate = new OutputGate(d => out.push(d))
        gate.push('user@host:~$ ')
        expect(out).toEqual([])
        gate.open()
        expect(out).toEqual(['user@host:~$ '])
        gate.push('x')
        expect(out).toEqual(['user@host:~$ ', 'x'])
    })

    it('drops output already contained in the capture and replays only newer output (review item 13)', () => {
        const out: string[] = []
        const gate = new OutputGate(d => out.push(d))
        gate.push('line 1\r\n')       // printed before tmux ran capture-pane: in the snapshot
        gate.captureStarted()
        gate.push('line 2\r\n')       // printed after the capture: not in the snapshot
        gate.open('SNAPSHOT(line 1)')
        expect(out).toEqual(['SNAPSHOT(line 1)', 'line 2\r\n'])
    })

    it('can hold again for a pane switch', () => {
        const out: string[] = []
        const gate = new OutputGate(d => out.push(d))
        gate.open()
        gate.hold()
        gate.push('a')
        gate.captureStarted()
        gate.push('b')
        gate.open('S')
        expect(out).toEqual(['S', 'b'])
    })
})
