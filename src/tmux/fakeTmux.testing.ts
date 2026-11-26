// SPDX-License-Identifier: GPL-3.0-only
//
// Test helper (no .spec suffix so it can be shared): a fake ControlTransport
// whose channel scripts tmux's control-mode replies.

import { Observable, Subject } from 'rxjs'
import type { ControlChannel, ControlTransport } from './transport'

const DCS_START = '\x1bP1000p'
const ST = '\x1b\\'

export type Reply = string[] | { error: string } | 'silent'

export interface FakeTmuxOptions {
    version?: string
    versionError?: Error
    /** Windows reported by list-windows, as "@id|index|%pane|active|auto|order|name". */
    windows?: string[]
    /** session_created / client_created seconds reported by display-message. */
    sessionCreated?: number
    clientCreated?: number
    /** How the fake answers the health-check ping. */
    ping?: 'ok' | 'error' | 'silent'
    /** Whether detach-client is answered with %exit and a closed channel. */
    detachExits?: boolean
    /** Extra notifications sent during start-up, before %session-changed. */
    startupNotifications?: string[]
    /** #{host}; also the #{pane_title} of a pane with no entry in `paneTitles`. */
    host?: string
    /** #{pane_title} per pane id, as set by a program (OSC 0/2). */
    paneTitles?: Record<string, string>
}

export class FakeChannel implements ControlChannel {
    readonly dataSubject = new Subject<Uint8Array>()
    readonly eof$ = new Subject<void>()
    readonly closed$ = new Subject<void>()
    readonly data$: Observable<Uint8Array>
    readonly writes: string[] = []
    closeCalls = 0
    isClosed = false
    private started = false
    private seq = 1000

    constructor (private readonly tmux: FakeTmux) {
        this.data$ = new Observable<Uint8Array>(subscriber => {
            const sub = this.dataSubject.subscribe(subscriber)
            if (!this.started) {
                this.started = true
                // Like a real channel, tmux starts talking once we listen.
                void Promise.resolve().then(() => this.tmux.startup(this))
            }
            return sub
        })
    }

    /** Commands written so far, one entry per command (batches split on ' ; '). */
    get commands (): string[] {
        return this.writes.flatMap(w => w.replace(/\r$/u, '').split(' ; '))
    }

    send (text: string): void {
        this.dataSubject.next(Buffer.from(text, 'utf8'))
    }

    reply (lines: string[], end: '%end' | '%error' = '%end'): void {
        const n = this.seq++
        this.send([`%begin 1700000002 ${n} 1`, ...lines, `${end} 1700000002 ${n} 1`].map(l => l + '\r\n').join(''))
    }

    /** tmux's %exit, the trailing ST, then EOF and close. */
    exit (reason?: string): void {
        this.send(`%exit${reason ? ' ' + reason : ''}\r\n${ST}`)
        this.eof$.next()
        this.remoteClose()
    }

    remoteClose (): void {
        if (!this.isClosed) {
            this.isClosed = true
            this.closed$.next()
        }
    }

    async write (data: Uint8Array): Promise<void> {
        if (this.isClosed) {
            throw new Error('channel closed')
        }
        const text = Buffer.from(data).toString('utf8')
        this.writes.push(text)
        const commands = text.replace(/\r$/u, '').split(' ; ')
        // Answer asynchronously, as a real server would. Like tmux, stop the
        // line at the first command that fails: later ones get no block.
        void Promise.resolve().then(() => {
            for (const command of commands) {
                if (this.tmux.answer(this, command) === 'error') {
                    break
                }
            }
        })
    }

    async close (): Promise<void> {
        this.closeCalls++
        this.remoteClose()
    }
}

export class FakeTmux implements ControlTransport {
    readonly sessionLost$ = new Subject<void>()
    readonly channels: FakeChannel[] = []
    holds = 0
    releases = 0
    openedSessions: string[] = []
    /** Per-command overrides, checked before the defaults. */
    readonly overrides = new Map<string, Reply>()
    /** Window user options set with `set-option -w -t @id @name value`, by window id. */
    readonly windowOptions = new Map<string, Map<string, string>>()

    constructor (public opts: FakeTmuxOptions = {}) {}

    get channel (): FakeChannel {
        return this.channels[this.channels.length - 1]
    }

    hold (): void {
        this.holds++
    }

    release (): void {
        this.releases++
    }

    async readTmuxVersion (): Promise<string> {
        if (this.opts.versionError) {
            throw this.opts.versionError
        }
        return this.opts.version ?? 'tmux 3.5a\n'
    }

    async openControlChannel (sessionName: string): Promise<FakeChannel> {
        this.openedSessions.push(sessionName)
        const channel = new FakeChannel(this)
        this.channels.push(channel)
        return channel
    }

    startup (channel: FakeChannel): void {
        const notifications = this.opts.startupNotifications ?? ['%window-add @0', '%sessions-changed']
        channel.send(`${DCS_START}%begin 1700000000 1 0\r\n%end 1700000000 1 0\r\n`)
        channel.send([...notifications, '%session-changed $0 main'].map(l => l + '\r\n').join(''))
    }

    /** Answer one command; 'error' when it got %error (tmux then skips the rest of the line). */
    answer (channel: FakeChannel, command: string): 'ok' | 'error' | 'none' {
        if (channel.isClosed) {
            return 'none'
        }
        const reply = this.overrides.get(command) ?? this.defaultReply(command)
        if (reply === 'silent') {
            return 'none'
        }
        if (Array.isArray(reply)) {
            channel.reply(reply)
        } else {
            channel.reply([reply.error], '%error')
        }
        if (command === 'detach-client' && (this.opts.detachExits ?? true)) {
            channel.exit('detached')
        }
        return Array.isArray(reply) ? 'ok' : 'error'
    }

    private defaultReply (command: string): Reply {
        if (command === 'display-message -p "__tomux_ready__"') {
            return ['__tomux_ready__']
        }
        if (command === 'display-message -p "__ping__"') {
            const mode = this.opts.ping ?? 'ok'
            return mode === 'ok' ? ['__ping__'] : mode === 'error' ? { error: 'no ping' } : 'silent'
        }
        if (command === 'display-message -p "#{session_created} #{client_created}"') {
            return [`${this.opts.sessionCreated ?? 1700000000} ${this.opts.clientCreated ?? 1700000100}`]
        }
        const paneTitle = /^display-message -p -t (%\d+) "#\{host\}\|#\{pane_title\}"$/u.exec(command)
        if (paneTitle) {
            const host = this.opts.host ?? 'testhost'
            return [`${host}|${this.opts.paneTitles?.[paneTitle[1]] ?? host}`]
        }
        const setOption = /^set-option -w -t (@\d+) (@\S+) (.*)$/u.exec(command)
        if (setOption) {
            const [, windowId, name, value] = setOption
            const options = this.windowOptions.get(windowId) ?? new Map<string, string>()
            options.set(name, value)
            this.windowOptions.set(windowId, options)
            return []
        }
        if (command.startsWith('list-windows')) {
            // The order field (the sixth) reports @tomux-order when it was set.
            return (this.opts.windows ?? ['@0|0|%0|1|1||bash']).map(line => {
                const parts = line.split('|')
                const order = this.windowOptions.get(parts[0])?.get('@tomux-order')
                if (order !== undefined && parts.length >= 7) {
                    parts[5] = order
                }
                return parts.join('|')
            })
        }
        return []
    }
}

/** Let queued promise callbacks run (enough for several reply round-trips). */
export async function settle (rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve()
    }
}
