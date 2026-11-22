// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
    CommandFlags,
    parseTmuxVersion,
    shellescape,
    tmuxAutomaticRenameIsOn,
    TmuxControlClient,
    TmuxGateway,
    versionAtLeast,
} from './controlClient'

/**
 * Fake transport: records every write the gateway makes and lets the test
 * answer the oldest unanswered command with canned response lines.
 */
class FakeTmux {
    readonly writes: string[] = []
    readonly gateway = new TmuxGateway(data => { this.writes.push(data) })
    readonly client = new TmuxControlClient(this.gateway)
    private seq = 100

    /** Feed tmux's start-up sequence so writes are no longer buffered. */
    start (): this {
        this.gateway.ingest('\x1bP1000p%begin 1700000000 1 0\r\n%end 1700000000 1 0\r\n')
        this.gateway.ingest('%session-changed $0 main\r\n')
        return this
    }

    /** Commands sent so far, without the trailing CR. */
    get commands (): string[] {
        return this.writes.map(w => w.replace(/\r$/, ''))
    }

    respond (lines: string[] = []): void {
        this.answer(lines, '%end')
    }

    fail (message: string): void {
        this.answer([message], '%error')
    }

    private answer (lines: string[], end: string): void {
        const n = this.seq++
        this.gateway.ingest([`%begin 1700000002 ${n} 1`, ...lines, `${end} 1700000002 ${n} 1`].map(l => l + '\r\n').join(''))
    }
}

describe('TmuxControlClient operations', () => {
    it('newWindow sends new-window -P -F and parses ids and index', async () => {
        const t = new FakeTmux().start()
        const p = t.client.newWindow()
        expect(t.commands).toEqual(['new-window -P -F "#{window_id} #{pane_id} #{window_index}"'])
        t.respond(['@12 %34 5'])
        await expect(p).resolves.toEqual({ windowId: '@12', paneId: '%34', windowIndex: 5 })
    })

    it('newWindow escapes name, start directory and shell', async () => {
        const t = new FakeTmux().start()
        const p = t.client.newWindow({ name: "it's mine", startDirectory: '/home/u/my dir', shell: 'bash -l' })
        expect(t.commands).toEqual([
            'new-window -P -F "#{window_id} #{pane_id} #{window_index}"'
                + " -n 'it'\\''s mine' -c '/home/u/my dir' 'bash -l'",
        ])
        t.respond(['@1 %1 1'])
        await p
    })

    it('newWindow rejects an unexpected response', async () => {
        const t = new FakeTmux().start()
        const p = t.client.newWindow()
        t.respond(['nonsense'])
        await expect(p).rejects.toThrow('Unexpected new-window response: nonsense')
    })

    it('listWindows uses the format string, with the name last, and parses every field', async () => {
        const t = new FakeTmux().start()
        const p = t.client.listWindows()
        expect(t.commands).toEqual([
            'list-windows -F "#{window_id}|#{window_index}|#{pane_id}|#{window_active}|#{automatic-rename}|#{window_name}"',
        ])
        t.respond([
            '@0|0|%0|0|1|zsh',
            '@3|1|%5|1|0|logs',
            '@4|2|%6|0|on|vim',
            '',
            // An old tmux expands the unknown #{automatic-rename} to nothing:
            // the window is treated as auto-renamed.
            '@7|3|%9|0||old',
            'garbage line',
        ])
        await expect(p).resolves.toEqual([
            { id: '@0', index: 0, name: 'zsh', paneId: '%0', active: false, automaticRename: true },
            { id: '@3', index: 1, name: 'logs', paneId: '%5', active: true, automaticRename: false },
            { id: '@4', index: 2, name: 'vim', paneId: '%6', active: false, automaticRename: true },
            { id: '@7', index: 3, name: 'old', paneId: '%9', active: false, automaticRename: true },
        ])
    })

    it.each([
        ['a|b', 'a|b'],
        ['|lead|trail|', '|lead|trail|'],
        ['my shell  two', 'my shell  two'],
        ['', ''],
        ['|', '|'],
    ])('listWindows keeps the other fields intact for the window name %j', async (raw, name) => {
        const t = new FakeTmux().start()
        const p = t.client.listWindows()
        t.respond([`@2|4|%8|1|0|${raw}`])
        await expect(p).resolves.toEqual([
            { id: '@2', index: 4, name, paneId: '%8', active: true, automaticRename: false },
        ])
    })

    it('killWindow sends kill-window and rejects on %error by default', async () => {
        const t = new FakeTmux().start()
        const p = t.client.killWindow('@3')
        expect(t.commands).toEqual(['kill-window -t @3'])
        t.fail("can't find window: @3")
        await expect(p).rejects.toThrow("can't find window: @3")
    })

    it('killWindow can tolerate errors', async () => {
        const t = new FakeTmux().start()
        const p = t.client.killWindow('@3', CommandFlags.TolerateErrors)
        t.fail("can't find window: @3")
        await expect(p).resolves.toBeUndefined()
    })

    it('renameWindow batches automatic-rename off and rename-window in one write', async () => {
        const t = new FakeTmux().start()
        const p = t.client.renameWindow('@2', "bob's shell")
        expect(t.writes).toEqual([
            "set-option -w -t @2 automatic-rename off ; rename-window -t @2 'bob'\\''s shell'\r",
        ])
        t.respond()
        t.fail('ignored')
        await expect(p).resolves.toBeUndefined()
    })

    it('selectWindow sends select-window and tolerates errors', async () => {
        const t = new FakeTmux().start()
        const p = t.client.selectWindow('@9')
        expect(t.commands).toEqual(['select-window -t @9'])
        t.fail("can't find window: @9")
        await expect(p).resolves.toBeUndefined()
    })

    it('refreshClient sends refresh-client -C cols,rows and tolerates errors', async () => {
        const t = new FakeTmux().start()
        const p = t.client.refreshClient(132, 43)
        expect(t.commands).toEqual(['refresh-client -C 132,43'])
        t.fail('unknown flag')
        await expect(p).resolves.toBeUndefined()
    })

    it('capturePane for adoption requests history and screen with escapes', async () => {
        const t = new FakeTmux().start()
        const p = t.client.capturePane('%5', { includeEscapeSequences: true, startLine: '-' })
        expect(t.commands).toEqual(['capture-pane -p -t %5 -e -S -'])
        t.respond(['\x1b[1mline one\x1b[0m', 'line two', ''])
        await expect(p).resolves.toBe('\x1b[1mline one\x1b[0m\nline two\n')
    })

    it('capturePane supports every option in the original order', async () => {
        const t = new FakeTmux().start()
        const p = t.client.capturePane('%5', {
            includeEscapeSequences: true,
            includePendingOnly: true,
            alternateScreen: true,
            joinWrappedLines: true,
            startLine: -100,
        })
        expect(t.commands).toEqual(['capture-pane -p -t %5 -e -P -a -J -S -100'])
        t.respond()
        await expect(p).resolves.toBe('')
    })

    it('capturePane with no options', async () => {
        const t = new FakeTmux().start()
        const p = t.client.capturePane('%1')
        expect(t.commands).toEqual(['capture-pane -p -t %1'])
        t.respond(['x'])
        await expect(p).resolves.toBe('x')
    })

    it('captureWithCursor sends capture-pane and the cursor and pane size query as one line', async () => {
        const t = new FakeTmux().start()
        const p = t.client.captureWithCursor('%5')
        expect(t.writes).toEqual([
            'capture-pane -p -e -J -S - -t %5 ; display-message -p -t %5 "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"\r',
        ])
        t.respond(['\x1b[1mline one\x1b[0m', 'line two', ''])
        t.respond(['7 22 182 48'])
        await expect(p).resolves.toEqual({
            text: '\x1b[1mline one\x1b[0m\nline two\n', cursorX: 7, cursorY: 22, paneWidth: 182, paneHeight: 48,
        })
    })

    it('captureWithCursor calls onCaptureStart at the capture\'s %begin, before later output', async () => {
        const t = new FakeTmux().start()
        const events: string[] = []
        t.gateway.on('output', o => { events.push(`output ${o.data}`) })
        const p = t.client.captureWithCursor('%5', { onCaptureStart: () => { events.push('capture start') } })
        t.gateway.ingest('%output %5 old\r\n')
        t.respond(['screen'])
        t.respond(['0 3 80 24'])
        t.gateway.ingest('%output %5 new\r\n')
        expect(events).toEqual(['output old', 'capture start', 'output new'])
        await expect(p).resolves.toEqual({ text: 'screen', cursorX: 0, cursorY: 3, paneWidth: 80, paneHeight: 24 })
    })

    it('captureWithCursor reads an unparseable cursor and pane size as 0', async () => {
        const t = new FakeTmux().start()
        const p = t.client.captureWithCursor('%5')
        t.respond([])
        t.respond(['?'])
        await expect(p).resolves.toEqual({ text: '', cursorX: 0, cursorY: 0, paneWidth: 0, paneHeight: 0 })
    })

    it('captureWithCursor rejects when the capture fails (the cursor query is skipped)', async () => {
        const t = new FakeTmux().start()
        const p = t.client.captureWithCursor('%5')
        t.fail("can't find pane: %5")
        await expect(p).rejects.toThrow("can't find pane: %5")
    })

    it('sendCommand and sendCommandList pass onBegin through to the gateway', async () => {
        const t = new FakeTmux().start()
        const begun: string[] = []
        const a = t.client.sendCommand('a', CommandFlags.None, { onBegin: () => { begun.push('a') } })
        const b = t.client.sendCommandList(['b', 'c'], CommandFlags.None, { onBegin: i => { begun.push(`list ${i}`) } })
        t.respond()
        t.respond()
        t.respond()
        await Promise.all([a, b])
        expect(begun).toEqual(['a', 'list 0', 'list 1'])
    })

    it('getPaneCursor parses x and y', async () => {
        const t = new FakeTmux().start()
        const p = t.client.getPaneCursor('%5')
        expect(t.commands).toEqual(['display-message -p -t %5 "#{cursor_x} #{cursor_y}"'])
        t.respond(['7 22'])
        await expect(p).resolves.toEqual({ x: 7, y: 22 })
    })
})

describe('TmuxControlClient ping', () => {
    it('sends the ping probe and resolves true on the echo', async () => {
        const t = new FakeTmux().start()
        const p = t.client.ping()
        expect(t.commands).toEqual(['display-message -p "__ping__"'])
        t.respond(['__ping__'])
        await expect(p).resolves.toBe(true)
    })

    it('resolves false on timeout', async () => {
        const t = new FakeTmux().start()
        await expect(t.client.ping(20)).resolves.toBe(false)
    })

    it('resolves false on %error or an unexpected response', async () => {
        const t = new FakeTmux().start()
        const a = t.client.ping()
        const b = t.client.ping()
        t.fail('no')
        t.respond(['something else'])
        await expect(a).resolves.toBe(false)
        await expect(b).resolves.toBe(false)
    })
})

describe('TmuxControlClient readiness', () => {
    it('sends the readiness probe after the handshake and resolves on its echo', async () => {
        const t = new FakeTmux()
        const ready = t.client.awaitReady()
        t.gateway.ingest('\x1bP1000p%begin 1700000000 1 0\r\n%end 1700000000 1 0\r\n')
        expect(t.writes).toEqual([])
        t.gateway.ingest('%window-add @0\r\n%sessions-changed\r\n%session-changed $0 main\r\n')
        expect(t.commands).toEqual(['display-message -p "__tomux_ready__"'])
        t.respond(['__tomux_ready__'])
        await expect(ready).resolves.toBeUndefined()
    })

    it('probes immediately when the handshake already happened', async () => {
        const t = new FakeTmux().start()
        const ready = t.client.awaitReady()
        expect(t.commands).toEqual(['display-message -p "__tomux_ready__"'])
        t.respond(['__tomux_ready__'])
        await expect(ready).resolves.toBeUndefined()
    })

    it('rejects on an unexpected probe response', async () => {
        const t = new FakeTmux().start()
        const ready = t.client.awaitReady()
        t.respond(['nope'])
        await expect(ready).rejects.toThrow('Unexpected tmux readiness response: ["nope"]')
    })

    it('rejects when the handshake does not arrive in time', async () => {
        const t = new FakeTmux()
        await expect(t.client.awaitReady(20)).rejects.toThrow('Timed out waiting for tmux control mode handshake')
        expect(t.gateway.listenerCount('_initial-handshake')).toBe(0)
    })
})

describe('tmux version helpers', () => {
    it.each([
        ['tmux 3.5a', { major: 3, minor: 5 }],
        ['tmux next-3.6', { major: 3, minor: 6 }],
        ['tmux 2.1', { major: 2, minor: 1 }],
        ['tmux 3.10', { major: 3, minor: 10 }],
        ['tmux openbsd-7.4', { major: 7, minor: 4 }],
        ['tmux 3.3a\n', { major: 3, minor: 3 }],
    ])('parses %j', (input, expected) => {
        expect(parseTmuxVersion(input)).toEqual(expected)
    })

    it.each(['tmux master', '', 'tmux 3'])('returns null for %j', input => {
        expect(parseTmuxVersion(input)).toBeNull()
    })

    it('compares versions', () => {
        const v = parseTmuxVersion('tmux 3.5a')
        expect(versionAtLeast(v, 2, 1)).toBe(true)
        expect(versionAtLeast(v, 3, 5)).toBe(true)
        expect(versionAtLeast(v, 3, 6)).toBe(false)
        expect(versionAtLeast(v, 4, 0)).toBe(false)
        expect(versionAtLeast(parseTmuxVersion('tmux 2.0'), 2, 1)).toBe(false)
        expect(versionAtLeast(parseTmuxVersion('tmux 3.10'), 3, 9)).toBe(true)
        expect(versionAtLeast(null, 0, 0)).toBe(false)
    })

    it('stores the version on the client', () => {
        const client = new TmuxControlClient(new TmuxGateway())
        expect(client.version).toBeNull()
        expect(client.versionAtLeast(2, 1)).toBe(false)
        client.setVersion('tmux 2.1')
        expect(client.version).toEqual({ major: 2, minor: 1 })
        expect(client.versionAtLeast(2, 1)).toBe(true)
        expect(client.versionAtLeast(2, 6)).toBe(false)
        client.setVersion('tmux master')
        expect(client.version).toEqual({ major: 2, minor: 1 })
    })
})

describe('helpers', () => {
    it('shellescape wraps in single quotes and escapes single quotes', () => {
        expect(shellescape('plain')).toBe("'plain'")
        expect(shellescape("it's")).toBe("'it'\\''s'")
        expect(shellescape('a "b" $c ; d')).toBe("'a \"b\" $c ; d'")
    })

    it('tmuxAutomaticRenameIsOn accepts the version-dependent spellings', () => {
        for (const v of ['1', 'on', 'yes', 'true', ' ON ']) {
            expect(tmuxAutomaticRenameIsOn(v)).toBe(true)
        }
        for (const v of ['0', 'off', '', undefined]) {
            expect(tmuxAutomaticRenameIsOn(v)).toBe(false)
        }
    })
})
