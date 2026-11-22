// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { CommandFlags, TmuxGateway, TmuxPaneOutput } from './gateway'

const DCS_START = '\x1bP1000p'
const ST = '\x1b\\'

/** Gateway whose writes are recorded. */
function makeGateway (): { gw: TmuxGateway, writes: string[] } {
    const writes: string[] = []
    const gw = new TmuxGateway(data => { writes.push(data) })
    return { gw, writes }
}

/** Gateway that has seen tmux's start-up sequence (writes flushed). */
function readyGateway (): { gw: TmuxGateway, writes: string[] } {
    const g = makeGateway()
    g.gw.ingest(`${DCS_START}%begin 1700000000 268 0\r\n%end 1700000000 268 0\r\n`)
    g.gw.ingest('%window-add @0\r\n%sessions-changed\r\n%session-changed $0 main\r\n')
    return g
}

function block (lines: string[], n = 1, end = '%end'): string {
    return [`%begin 1700000001 ${n} 1`, ...lines, `${end} 1700000001 ${n} 1`].map(l => l + '\r\n').join('')
}

function collectOutput (gw: TmuxGateway): TmuxPaneOutput[] {
    const out: TmuxPaneOutput[] = []
    gw.on('output', o => { out.push(o) })
    return out
}

const flushImmediate = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('TmuxGateway framing', () => {
    it('strips the DCS introducer that precedes the first %begin', () => {
        const { gw } = makeGateway()
        const handshake = vi.fn()
        gw.on('_initial-handshake', handshake)
        gw.ingest(`${DCS_START}%begin 1 1 0\r\n%end 1 1 0\r\n`)
        expect(handshake).toHaveBeenCalledTimes(1)
        expect(gw.isHandshakeDone).toBe(true)
    })

    it('parses a line that directly follows the DCS introducer', () => {
        const { gw } = makeGateway()
        const changed = vi.fn()
        gw.on('session-changed', changed)
        gw.ingest(`${DCS_START}%session-changed $1 main\r\n`)
        expect(changed).toHaveBeenCalledWith('$1 main')
    })

    it.each([
        ['after ESC', 1],
        ['after ESC P', 2],
        ['inside the parameters', 4],
        ['right after the final byte', DCS_START.length],
    ])('handles the DCS introducer split across two chunks (%s)', (_label, cut) => {
        const { gw } = makeGateway()
        const changed = vi.fn()
        gw.on('session-changed', changed)
        const stream = `${DCS_START}%session-changed $1 main\r\n`
        gw.ingest(stream.slice(0, cut))
        expect(changed).not.toHaveBeenCalled()
        gw.ingest(stream.slice(cut))
        expect(changed).toHaveBeenCalledWith('$1 main')
    })

    it('treats the first %begin after DCS as a block, so its lines are not notifications', () => {
        const { gw } = makeGateway()
        const added = vi.fn()
        gw.on('window-add', added)
        // A plain (non-%) line inside the block is response text, never parsed.
        gw.ingest(`${DCS_START}%begin 1 1 0\r\nwindow-add @7\r\n%end 1 1 0\r\n`)
        expect(added).not.toHaveBeenCalled()
    })

    it('emits tmux-exit on %exit and swallows the trailing ST', () => {
        const { gw } = readyGateway()
        const exit = vi.fn()
        const added = vi.fn()
        gw.on('tmux-exit', exit)
        gw.on('window-add', added)
        gw.ingest(`%exit\r\n${ST}`)
        expect(exit).toHaveBeenCalledTimes(1)
        expect(exit).toHaveBeenCalledWith(undefined)
        // Nothing of the ST is left to prefix the next line.
        gw.ingest('%window-add @9\r\n')
        expect(added).toHaveBeenCalledWith('@9')
    })

    it('passes the %exit reason', () => {
        const { gw } = readyGateway()
        const exit = vi.fn()
        gw.on('tmux-exit', exit)
        gw.ingest('%exit detached\r\n')
        expect(exit).toHaveBeenCalledWith('detached')
    })

    it('swallows an ST split across chunks or followed by CRLF', () => {
        const { gw } = readyGateway()
        const added = vi.fn()
        gw.on('window-add', added)
        gw.ingest('%exit\r\n\x1b')
        gw.ingest('\\')
        gw.ingest('%window-add @1\r\n')
        gw.ingest(`%window-add @2${ST}\r\n`)
        gw.ingest(`${ST}\r\n%window-add @3\r\n`)
        expect(added.mock.calls).toEqual([['@1'], ['@2'], ['@3']])
    })

    it('reassembles a line split across chunks, including between CR and LF', () => {
        const { gw } = readyGateway()
        const added = vi.fn()
        gw.on('window-add', added)
        gw.ingest('%window-')
        gw.ingest('add @4\r')
        expect(added).not.toHaveBeenCalled()
        gw.ingest('\n')
        expect(added).toHaveBeenCalledWith('@4')
    })

    it('accepts LF-only line endings', () => {
        const { gw } = readyGateway()
        const added = vi.fn()
        gw.on('window-add', added)
        gw.ingest('%window-add @5\n')
        expect(added).toHaveBeenCalledWith('@5')
    })
})

describe('TmuxGateway command responses', () => {
    it('matches responses to commands in order', async () => {
        const { gw, writes } = readyGateway()
        const a = gw.sendCommand('display-message -p a')
        const b = gw.sendCommand('display-message -p b')
        const c = gw.sendCommand('list-windows')
        expect(writes).toEqual(['display-message -p a\r', 'display-message -p b\r', 'list-windows\r'])
        gw.ingest(block(['a'], 1) + block(['b'], 2) + block(['@0 one', '@1 two'], 3))
        await expect(a).resolves.toEqual(['a'])
        await expect(b).resolves.toEqual(['b'])
        await expect(c).resolves.toEqual(['@0 one', '@1 two'])
    })

    it('resolves an empty block with no lines', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('select-window -t @1')
        gw.ingest(block([]))
        await expect(p).resolves.toEqual([])
    })

    it('sends a command list as one write and resolves one result per command', async () => {
        const { gw, writes } = readyGateway()
        const p = gw.sendCommandList(['set-option -w -t @1 automatic-rename off', "rename-window -t @1 'x'", 'list-windows'])
        expect(writes).toEqual(["set-option -w -t @1 automatic-rename off ; rename-window -t @1 'x' ; list-windows\r"])
        gw.ingest(block([], 1) + block([], 2) + block(['@1'], 3))
        await expect(p).resolves.toEqual([[], [], ['@1']])
    })

    it('resolves an empty command list without writing', async () => {
        const { gw, writes } = readyGateway()
        await expect(gw.sendCommandList([])).resolves.toEqual([])
        expect(writes).toEqual([])
    })

    it('rejects on %error with the error text and keeps later commands matched', async () => {
        const { gw } = readyGateway()
        const bad = gw.sendCommand('kill-window -t @99')
        const good = gw.sendCommand('display-message -p ok')
        gw.ingest(block(["can't find window: @99"], 1, '%error') + block(['ok'], 2))
        await expect(bad).rejects.toThrow("can't find window: @99")
        await expect(good).resolves.toEqual(['ok'])
    })

    it('rejects on an empty %error block with the %error line itself', async () => {
        const { gw } = readyGateway()
        const bad = gw.sendCommand('bogus')
        gw.ingest(block([], 4, '%error'))
        await expect(bad).rejects.toThrow('%error 1700000001 4 1')
    })

    it('resolves [] on %error with TolerateErrors', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('kill-window -t @99', CommandFlags.TolerateErrors)
        gw.ingest(block(["can't find window: @99"], 1, '%error'))
        await expect(p).resolves.toEqual([])
    })

    it('tolerates an error inside a command list with TolerateErrors', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommandList(['a', 'b', 'c'], CommandFlags.TolerateErrors)
        // tmux runs `a`, which succeeds, then `b`, which fails; it skips `c`
        // and sends no block for it.
        gw.ingest(block(['fine'], 1) + block(['bad'], 2, '%error'))
        await expect(p).resolves.toEqual([['fine'], [], []])
    })

    it('settles the members after a failed one at once and keeps later replies matched', async () => {
        const { gw } = readyGateway()
        const list = gw.sendCommandList(['a', 'b', 'c', 'd'], CommandFlags.TolerateErrors)
        const after = gw.sendCommand('display-message -p after')
        gw.ingest(block(['A'], 1) + block(['boom'], 2, '%error'))
        // No block ever comes for `c` or `d`: the list resolves now.
        await expect(list).resolves.toEqual([['A'], [], [], []])
        // The next block belongs to the command after the list, not to `c`.
        gw.ingest(block(['after'], 3))
        await expect(after).resolves.toEqual(['after'])
    })

    it('rejects skipped members with a clear error and does not hand them later replies', async () => {
        const { gw } = readyGateway()
        const list = gw.sendCommandList(['a', 'b', 'c'])
        const after = gw.sendCommand('display-message -p after')
        gw.ingest(block(['boom'], 1, '%error'))
        await expect(list).rejects.toThrow('boom')
        gw.ingest(block(['after'], 2))
        await expect(after).resolves.toEqual(['after'])
    })

    it('calls onBegin only for the members tmux ran', async () => {
        const { gw } = readyGateway()
        const begun: number[] = []
        const list = gw.sendCommandList(['a', 'b', 'c'], CommandFlags.None, { onBegin: i => { begun.push(i) } })
        gw.ingest(block([], 1) + block(['boom'], 2, '%error'))
        await expect(list).rejects.toThrow('boom')
        expect(begun).toEqual([0, 1])
    })

    it('a parse error of the whole line (one %error block) settles every member', async () => {
        const { gw } = readyGateway()
        const list = gw.sendCommandList(['a', 'b'], CommandFlags.TolerateErrors)
        const next = gw.sendCommand('next')
        gw.ingest(block(['syntax error'], 1, '%error') + block(['n'], 2))
        await expect(list).resolves.toEqual([[], []])
        await expect(next).resolves.toEqual(['n'])
    })

    it('an error in one list does not skip the members of the next list', async () => {
        const { gw, writes } = readyGateway()
        const first = gw.sendCommandList(['a', 'b'], CommandFlags.TolerateErrors)
        const second = gw.sendCommandList(['c', 'd'], CommandFlags.TolerateErrors)
        expect(writes).toEqual(['a ; b\r', 'c ; d\r'])
        gw.ingest(block(['x'], 1, '%error') + block(['C'], 2) + block(['D'], 3))
        await expect(first).resolves.toEqual([[], []])
        await expect(second).resolves.toEqual([['C'], ['D']])
    })

    it('a failed single command skips nothing after it', async () => {
        const { gw } = readyGateway()
        const bad = gw.sendCommand('bad', CommandFlags.TolerateErrors)
        const list = gw.sendCommandList(['a', 'b'])
        gw.ingest(block(['x'], 1, '%error') + block(['A'], 2) + block(['B'], 3))
        await expect(bad).resolves.toEqual([])
        await expect(list).resolves.toEqual([['A'], ['B']])
    })

    it('rejects a command list when one command fails without TolerateErrors', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommandList(['a', 'b'])
        gw.ingest(block(['ok'], 1) + block(['boom'], 2, '%error'))
        await expect(p).rejects.toThrow('boom')
    })

    it('handles notifications before, between and after response blocks', async () => {
        const { gw } = readyGateway()
        const events: string[] = []
        gw.on('window-add', id => { events.push(`add ${id}`) })
        gw.on('window-renamed', r => { events.push(`renamed ${r?.windowId} ${r?.name}`) })
        gw.on('window-close', id => { events.push(`close ${id}`) })
        const output = collectOutput(gw)

        const a = gw.sendCommand('list-windows')
        const b = gw.sendCommand('display-message -p b')
        gw.ingest('%window-add @2\r\n%output %3 before\r\n')
        gw.ingest('%begin 1700000001 7 1\r\n@0 zero\r\n')
        gw.ingest('@2 logs\r\n%end 1700000001 7 1\r\n%window-renamed @2 logs\r\n%output %3 between\r\n')
        gw.ingest(block(['b'], 8) + '%window-close @2\r\n%output %3 after\r\n')

        await expect(a).resolves.toEqual(['@0 zero', '@2 logs'])
        await expect(b).resolves.toEqual(['b'])
        expect(events).toEqual(['add @2', 'renamed @2 logs', 'close @2'])
        expect(output.map(o => o.data)).toEqual(['before', 'between', 'after'])
    })

    it('keeps empty lines and %-prefixed lines inside a block as response text', async () => {
        const { gw } = readyGateway()
        const events = vi.fn()
        gw.on('window-close', events)
        gw.on('tmux-exit', events)
        gw.on('output', events)
        const p = gw.sendCommand('capture-pane -p -t %1')
        gw.ingest(block(['top', '', '%window-close @1', '%output %1 x', '%exit', '%end', '%end 1 2 3', '', 'bottom'], 9))
        await expect(p).resolves.toEqual(['top', '', '%window-close @1', '%output %1 x', '%exit', '%end', '%end 1 2 3', '', 'bottom'])
        expect(events).not.toHaveBeenCalled()
    })

    it('keeps a response line that ends in ST (e.g. an OSC 8 link) intact', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('capture-pane -p -e -t %1')
        const link = '\x1b]8;;file-a\x1b\\link\x1b]8;;\x1b\\'
        gw.ingest(block([link, '\x1b\\tail'], 10))
        await expect(p).resolves.toEqual([link, '\x1b\\tail'])
    })

    it('falls back to prefix matching when %begin has no arguments', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('x')
        gw.ingest('%begin\r\nline\r\n%end\r\n')
        await expect(p).resolves.toEqual(['line'])
    })

    it('does not hand the initial block to a command queued before the handshake', async () => {
        const { gw, writes } = makeGateway()
        const handshake = vi.fn()
        gw.on('_initial-handshake', handshake)
        const early = gw.sendCommand('list-windows')
        gw.ingest(`${DCS_START}%begin 1 1 0\r\n%end 1 1 0\r\n%session-changed $0 main\r\n`)
        expect(handshake).toHaveBeenCalledTimes(1)
        expect(writes).toEqual(['list-windows\r'])
        gw.ingest(block(['@0'], 2))
        await expect(early).resolves.toEqual(['@0'])
    })

    it('rejects pending commands on drainOnExit', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('list-windows')
        gw.drainOnExit()
        await expect(p).rejects.toThrow('tmux process exited')
    })
})

describe('TmuxGateway after the end', () => {
    it('rejects commands sent after close() at once, without writing', async () => {
        const { gw, writes } = readyGateway()
        gw.close()
        expect(gw.isClosed).toBe(true)
        await expect(gw.sendCommand('list-windows')).rejects.toThrow('tmux connection has ended')
        await expect(gw.sendCommandList(['a', 'b'])).rejects.toThrow('tmux connection has ended')
        expect(writes).toEqual([])
    })

    it('close() rejects pending commands, including ones still buffered before the flush', async () => {
        const { gw, writes } = makeGateway()
        const buffered = gw.sendCommand('early')
        gw.close()
        await expect(buffered).rejects.toThrow('tmux process exited')
        // A late %session-changed does not write the dropped command.
        gw.ingest(block([], 1) + '%session-changed $0 main\r\n')
        expect(writes).toEqual([])
    })

    it('%exit closes the gateway: pending commands reject and new ones reject at once', async () => {
        const { gw } = readyGateway()
        const pending = gw.sendCommand('list-windows')
        gw.ingest('%exit\r\n')
        await expect(pending).rejects.toThrow('tmux process exited')
        await expect(gw.sendCommand('x')).rejects.toThrow('tmux connection has ended')
    })

    it('drainOnExit also closes the gateway', async () => {
        const { gw } = readyGateway()
        gw.drainOnExit()
        await expect(gw.sendCommand('x')).rejects.toThrow('tmux connection has ended')
    })
})

describe('TmuxGateway onBegin', () => {
    it('calls onBegin when the command\'s %begin is parsed, before later %output', () => {
        const { gw } = readyGateway()
        const events: string[] = []
        gw.on('output', o => { events.push(`output ${o.data}`) })
        void gw.sendCommand('display-message -p one', CommandFlags.None, { onBegin: () => { events.push('begin one') } })
        void gw.sendCommand('display-message -p two', CommandFlags.None, { onBegin: () => { events.push('begin two') } })
        gw.ingest('%output %1 before\r\n'
            + '%begin 1700000001 1 1\r\n')
        expect(events).toEqual(['output before', 'begin one'])
        gw.ingest('one\r\n%end 1700000001 1 1\r\n'
            + '%output %1 between\r\n'
            + block(['two'], 2)
            + '%output %1 after\r\n')
        expect(events).toEqual(['output before', 'begin one', 'output between', 'begin two', 'output after'])
    })

    it('calls the list onBegin with each member\'s index, interleaved with %output', () => {
        const { gw } = readyGateway()
        const events: string[] = []
        gw.on('output', o => { events.push(`output ${o.data}`) })
        void gw.sendCommandList(['a', 'b'], CommandFlags.None, { onBegin: i => { events.push(`begin ${i}`) } })
        gw.ingest('%output %1 x\r\n' + block(['A'], 1) + '%output %1 y\r\n' + block(['B'], 2) + '%output %1 z\r\n')
        expect(events).toEqual(['output x', 'begin 0', 'output y', 'begin 1', 'output z'])
    })

    it('does not call onBegin for the initial handshake block or a command not yet sent', () => {
        const { gw } = makeGateway()
        const onBegin = vi.fn()
        void gw.sendCommand('early', CommandFlags.None, { onBegin })
        gw.ingest(`${DCS_START}%begin 1 1 0\r\n%end 1 1 0\r\n`)
        expect(onBegin).not.toHaveBeenCalled()
        gw.ingest('%session-changed $0 main\r\n' + block([], 2))
        expect(onBegin).toHaveBeenCalledTimes(1)
    })

    it('keeps parsing when onBegin throws', async () => {
        const { gw } = readyGateway()
        const p = gw.sendCommand('x', CommandFlags.None, { onBegin: () => { throw new Error('listener bug') } })
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        gw.ingest(block(['ok'], 1))
        spy.mockRestore()
        await expect(p).resolves.toEqual(['ok'])
    })
})

describe('TmuxGateway write buffering', () => {
    it('buffers writes until %session-changed, then flushes them in order', async () => {
        const { gw, writes } = makeGateway()
        const handshake = vi.fn()
        gw.on('_initial-handshake', handshake)
        gw.ingest(`${DCS_START}%begin 1 1 0\r\n%end 1 1 0\r\n`)
        expect(handshake).toHaveBeenCalledTimes(1)
        expect(gw.isHandshakeDone).toBe(true)

        const first = gw.sendCommand('display-message -p one')
        const list = gw.sendCommandList(['a', 'b'])
        expect(writes).toEqual([])
        expect(gw.isSessionReady).toBe(false)

        gw.ingest('%window-add @0\r\n%sessions-changed\r\n')
        expect(writes).toEqual([])
        gw.ingest('%session-changed $0 main\r\n')
        expect(gw.isSessionReady).toBe(true)
        expect(writes).toEqual(['display-message -p one\r', 'a ; b\r'])

        gw.ingest(block(['one'], 2) + block(['A'], 3) + block(['B'], 4))
        await expect(first).resolves.toEqual(['one'])
        await expect(list).resolves.toEqual([['A'], ['B']])

        // After the flush, writes go straight through.
        void gw.sendCommand('x')
        expect(writes[writes.length - 1]).toBe('x\r')
    })

    it('flushes on the next tick after the first %end when %session-changed never comes (tmux < 2.6)', async () => {
        const { gw, writes } = makeGateway()
        gw.on('_initial-handshake', () => { void gw.sendCommand('display-message -p ready') })
        gw.ingest('%begin 1 1 0\n%end 1 1 0\n')
        expect(writes).toEqual([])
        await flushImmediate()
        expect(writes).toEqual(['display-message -p ready\r'])
    })

    it('flushes only once when %session-changed arrives in the same chunk as the first %end', async () => {
        const { gw, writes } = makeGateway()
        gw.on('_initial-handshake', () => { void gw.sendCommand('probe') })
        gw.ingest(`${DCS_START}%begin 1 1 0\r\n%end 1 1 0\r\n%session-changed $0 main\r\n`)
        expect(writes).toEqual(['probe\r'])
        await flushImmediate()
        expect(writes).toEqual(['probe\r'])
    })

    it('emits the initial handshake only once', () => {
        const { gw } = makeGateway()
        const handshake = vi.fn()
        gw.on('_initial-handshake', handshake)
        gw.ingest(block([], 1) + '%session-changed $0 main\r\n' + block([], 2))
        expect(handshake).toHaveBeenCalledTimes(1)
    })
})

describe('TmuxGateway pane output', () => {
    it('decodes a multi-byte UTF-8 character split across two %output notifications once', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        // "é" is C3 A9; "€" is E2 82 AC (octal-escaped here).
        gw.ingest('%output %1 caf\\303\r\n')
        gw.ingest('%output %1 \\251 \\342\\202\r\n')
        gw.ingest('%output %1 \\254\r\n')
        expect(output.map(o => o.data).join('')).toBe('café €')
        expect(output.map(o => o.data)).toEqual(['caf', 'é ', '€'])
    })

    it('decodes raw (unescaped) UTF-8 bytes split across notifications', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        const euro = Buffer.from('€', 'utf8')
        gw.ingest(Buffer.concat([Buffer.from('%output %1 '), euro.subarray(0, 1), Buffer.from('\r\n')]))
        gw.ingest(Buffer.concat([Buffer.from('%output %1 '), euro.subarray(1), Buffer.from('!\r\n')]))
        expect(output.map(o => o.data)).toEqual(['', '€!'])
    })

    it('keeps one UTF-8 decoder per pane', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 \\303\r\n%output %2 x\r\n%output %1 \\251\r\n')
        expect(output).toEqual([
            { paneId: '%1', data: '' },
            { paneId: '%2', data: 'x' },
            { paneId: '%1', data: 'é' },
        ])
    })

    it('drops a pane decoder on removePaneDecoder', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 \\303\r\n')
        gw.removePaneDecoder('%1')
        gw.ingest('%output %1 ok\r\n')
        expect(output[1]).toEqual({ paneId: '%1', data: 'ok' })
    })

    it('preserves ESC in octal-escaped sequences such as a cursor-position report', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 \\033[12;40R\r\n')
        expect(output[0].data).toBe('\x1b[12;40R')
    })

    it('preserves a bare ESC and other control bytes, dropping only bare CR', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest(Buffer.from('%output %1 \x1b[?1;2c\x07a\rb\r\n', 'binary'))
        expect(output[0].data).toBe('\x1b[?1;2c\x07ab')
    })

    it('keeps escaped CR LF in the payload while the line CRLF is framing', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 one\\015\\012two\\015\\012\r\n')
        expect(output[0].data).toBe('one\r\ntwo\r\n')
    })

    it('decodes escaped backslashes and leaves invalid escapes alone', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 C:\\134dir \\9x \\12\r\n')
        expect(output[0].data).toBe('C:\\dir \\9x \\12')
    })

    it('skips a bare CR inside an octal escape', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 \\0\r33[0m\r\n')
        expect(output[0].data).toBe('\x1b[0m')
    })

    it('decodes %extended-output', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%extended-output %4 120 : \\033[1mbold\r\n')
        expect(output).toEqual([{ paneId: '%4', data: '\x1b[1mbold' }])
    })

    it('decodes %output with an empty payload to an empty string', () => {
        const { gw } = readyGateway()
        const output = collectOutput(gw)
        gw.ingest('%output %1 \r\n')
        expect(output).toEqual([{ paneId: '%1', data: '' }])
    })
})

describe('TmuxGateway notifications', () => {
    it('emits the window and session notifications', () => {
        const { gw } = readyGateway()
        const seen: unknown[] = []
        gw.on('window-add', id => { seen.push(['window-add', id]) })
        gw.on('window-close', id => { seen.push(['window-close', id]) })
        gw.on('window-renamed', r => { seen.push(['window-renamed', r]) })
        gw.on('layout-change', l => { seen.push(['layout-change', l]) })
        gw.on('window-pane-changed', c => { seen.push(['window-pane-changed', c]) })
        gw.on('session-window-changed', c => { seen.push(['session-window-changed', c]) })
        gw.on('session-renamed', s => { seen.push(['session-renamed', s]) })
        gw.on('sessions-changed', () => { seen.push(['sessions-changed']) })
        gw.on('session-changed', s => { seen.push(['session-changed', s]) })
        gw.on('pane-mode-changed', p => { seen.push(['pane-mode-changed', p]) })
        gw.on('paste-buffer-changed', () => { seen.push(['paste-buffer-changed']) })
        gw.on('pause', p => { seen.push(['pause', p]) })
        gw.on('continue', p => { seen.push(['continue', p]) })
        gw.on('message', m => { seen.push(['message', m]) })

        gw.ingest([
            '%window-add @3',
            '%window-close @3',
            '%unlinked-window-close @4',
            '%window-renamed @5 my name with spaces',
            '%layout-change @5 b25d,80x24,0,0,1 b25d,80x24,0,0,1 *',
            '%window-pane-changed @5 %7',
            '%session-window-changed $1 @5',
            '%session-renamed $1 work',
            '%sessions-changed',
            '%session-changed $1 work',
            '%pane-mode-changed %7',
            '%paste-buffer-changed buffer0',
            '%pause %7',
            '%continue %7',
            '%message hello there',
            '%client-detached /dev/pts/1',
        ].map(l => l + '\r\n').join(''))

        expect(seen).toEqual([
            ['window-add', '@3'],
            ['window-close', '@3'],
            ['window-close', '@4'],
            ['window-renamed', { windowId: '@5', name: 'my name with spaces' }],
            ['layout-change', { windowId: '@5', layout: 'b25d,80x24,0,0,1', visibleLayout: 'b25d,80x24,0,0,1', flags: '*' }],
            ['window-pane-changed', { windowId: '@5', paneId: '%7' }],
            ['session-window-changed', { sessionId: '$1', windowId: '@5' }],
            ['session-renamed', '$1 work'],
            ['sessions-changed'],
            ['session-changed', '$1 work'],
            ['pane-mode-changed', '%7'],
            ['paste-buffer-changed'],
            ['pause', '%7'],
            ['continue', '%7'],
            ['message', 'hello there'],
        ])
    })

    it('keeps a UTF-8 window name intact', () => {
        const { gw } = readyGateway()
        const renamed = vi.fn()
        gw.on('window-renamed', renamed)
        gw.ingest(Buffer.from('%window-renamed @1 café ☕\r\n', 'utf8'))
        expect(renamed).toHaveBeenCalledWith({ windowId: '@1', name: 'café ☕' })
    })
})

describe('TmuxGateway writer', () => {
    it('uses a writer set after construction', () => {
        const gw = new TmuxGateway()
        const writes: string[] = []
        gw.setWriter(d => { writes.push(d) })
        gw.ingest(block([], 1) + '%session-changed $0 main\r\n')
        void gw.sendCommand('list-windows')
        expect(writes).toEqual(['list-windows\r'])
    })
})
