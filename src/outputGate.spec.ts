// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { GateEntry, OutputGate } from './outputGate'

/**
 * A gate whose entries are recorded as strings: text as it is, `redraw:TEXT@N`
 * for a redraw at N rows (`?` unknown), `cell=N` for a layout change, `reapply`.
 */
function recordingGate (onEmit?: (gate: OutputGate, entry: string) => void): { gate: OutputGate, out: string[] } {
    const out: string[] = []
    const gate: OutputGate = new OutputGate((entry: GateEntry) => {
        const text = entry.kind === 'text' ? entry.text
            : entry.kind === 'redraw' ? `redraw:${entry.text}@${entry.rows?.pane ?? '?'}`
            : entry.kind === 'layout' ? `cell=${entry.cell.height}`
            : 'reapply'
        out.push(text)
        onEmit?.(gate, text)
    })
    return { gate, out }
}

const rows = (pane: number): { pane: number, window: number } => ({ pane, window: 25 })
const cell = (height: number): { height: number, atTop: boolean, atBottom: boolean, window: number } =>
    ({ height, atTop: true, atBottom: false, window: 25 })

describe('OutputGate', () => {
    it('keeps a new window\'s first prompt that arrives before setup finishes (review item 3)', () => {
        const { gate, out } = recordingGate()
        gate.push('user@host:~$ ')
        expect(out).toEqual([])
        gate.open()
        expect(out).toEqual(['user@host:~$ '])
        gate.push('x')
        expect(out).toEqual(['user@host:~$ ', 'x'])
    })

    it('drops output already contained in the capture and replays only newer output (review item 13)', () => {
        const { gate, out } = recordingGate()
        gate.push('line 1\r\n')       // printed before tmux ran capture-pane: in the snapshot
        gate.captureStarted()
        gate.push('line 2\r\n')       // printed after the capture: not in the snapshot
        gate.open({ text: 'SNAPSHOT(line 1)', rows: rows(24) })
        expect(out).toEqual(['redraw:SNAPSHOT(line 1)@24', 'line 2\r\n'])
    })

    it('can hold again for a pane switch', () => {
        const { gate, out } = recordingGate()
        gate.open()
        gate.hold()
        gate.push('a')
        gate.captureStarted()
        gate.push('b')
        gate.open({ text: 'S', rows: null })
        expect(out).toEqual(['redraw:S@?', 'b'])
    })

    it('keeps layout changes in order with the output, and drops those older than the capture', () => {
        const { gate, out } = recordingGate()
        gate.pushLayout(cell(25))     // older than the capture: its rows are in it
        gate.captureStarted()
        gate.push('a')
        gate.pushLayout(cell(11))
        gate.pushReapply()
        gate.push('b')
        gate.open({ text: 'S', rows: rows(12) })
        expect(out).toEqual(['redraw:S@12', 'a', 'cell=11', 'reapply', 'b'])
        gate.pushLayout(cell(7))
        expect(out[out.length - 1]).toBe('cell=7')
    })

    it('holds what is left when an entry it lets through makes it hold again', () => {
        // A layout change that needs a redraw holds the gate from inside emit.
        const { gate, out } = recordingGate((g, entry) => {
            if (entry === 'cell=11') {
                g.hold()
            }
        })
        gate.captureStarted()
        gate.push('a')
        gate.pushLayout(cell(11))
        gate.push('b')
        gate.open({ text: 'S', rows: rows(25) })
        expect(out).toEqual(['redraw:S@25', 'a', 'cell=11'])
        expect(gate.isHolding).toBe(true)
        gate.push('c')
        gate.captureStarted()         // the new capture contains 'b' and 'c'
        gate.push('d')
        gate.open({ text: 'T', rows: rows(11) })
        expect(out).toEqual(['redraw:S@25', 'a', 'cell=11', 'redraw:T@11', 'd'])
    })
})
