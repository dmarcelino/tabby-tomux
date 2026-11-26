// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { OutputGate } from './outputGate'

describe('OutputGate', () => {
    it('keeps a new window\'s first prompt that arrives before setup finishes (review item 3)', () => {
        const out: string[] = []
        const push = (d: string) => { out.push(d) }
        const gate = new OutputGate(push, push)
        gate.push('user@host:~$ ')
        expect(out).toEqual([])
        gate.open()
        expect(out).toEqual(['user@host:~$ '])
        gate.push('x')
        expect(out).toEqual(['user@host:~$ ', 'x'])
    })

    it('drops output already contained in the capture and replays only newer output (review item 13)', () => {
        const out: string[] = []
        const push = (d: string) => { out.push(d) }
        const gate = new OutputGate(push, push)
        gate.push('line 1\r\n')       // printed before tmux ran capture-pane: in the snapshot
        gate.captureStarted()
        gate.push('line 2\r\n')       // printed after the capture: not in the snapshot
        gate.open('SNAPSHOT(line 1)')
        expect(out).toEqual(['SNAPSHOT(line 1)', 'line 2\r\n'])
    })

    it('can hold again for a pane switch', () => {
        const out: string[] = []
        const push = (d: string) => { out.push(d) }
        const gate = new OutputGate(push, push)
        gate.open()
        gate.hold()
        gate.push('a')
        gate.captureStarted()
        gate.push('b')
        gate.open('S')
        expect(out).toEqual(['S', 'b'])
    })

    // Replays (history drawn again from tmux) must not reach Tabby's session
    // middleware, so the gate hands them to a separate output.
    describe('replay and live output', () => {
        function recordingGate (): { gate: OutputGate, events: string[] } {
            const events: string[] = []
            const gate = new OutputGate(d => events.push(`live:${d}`), d => events.push(`replay:${d}`))
            return { gate, events }
        }

        it('sends the snapshot to the replay output and held output to the live output, in that order', () => {
            const { gate, events } = recordingGate()
            gate.push('old')
            gate.captureStarted()
            gate.push('newer')
            gate.open('SNAP')
            gate.push('later')
            expect(events).toEqual(['replay:SNAP', 'live:newer', 'live:later'])
        })

        it('does the same when it opens again after holding for a pane switch', () => {
            const { gate, events } = recordingGate()
            gate.open()
            gate.push('a')
            gate.hold()
            gate.push('b')
            gate.captureStarted()
            gate.push('c')
            gate.open('SNAP2')
            expect(events).toEqual(['live:a', 'replay:SNAP2', 'live:c'])
        })

        it('uses only the live output when there is no snapshot', () => {
            const { gate, events } = recordingGate()
            gate.push('prompt')
            gate.open()
            expect(events).toEqual(['live:prompt'])
        })
    })
})
