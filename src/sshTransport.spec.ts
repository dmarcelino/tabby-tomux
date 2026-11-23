// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Subject } from 'rxjs'
import { SshControlTransport, SshSessionLike } from './sshTransport'

/** A russh-like channel whose requests can be made to fail. */
class FakeRusshChannel {
    readonly data$ = new Subject<Uint8Array>()
    readonly extendedData$ = new Subject<[number, Uint8Array]>()
    readonly eof$ = new Subject<void>()
    readonly closed$ = new Subject<void>()
    readonly execs: string[] = []
    readonly ptys: string[] = []
    closeCalls = 0
    ptyError: Error | null = null
    execError: Error | null = null
    /** Output the exec'd command prints before the channel closes; null = never answers. */
    output: string | null = 'tmux 3.5a\n'
    /** What the command prints on stderr (extended data type 1). */
    stderr = ''
    /** Whether the remote sends EOF before closing the channel. */
    sendsEof = true
    /** How long the command runs before it prints and exits. */
    runMs = 0

    async requestPTY (terminal: string): Promise<void> {
        this.ptys.push(terminal)
        if (this.ptyError) {
            throw this.ptyError
        }
    }

    async requestExec (command: string): Promise<void> {
        this.execs.push(command)
        if (this.execError) {
            throw this.execError
        }
        const output = this.output
        if (output !== null) {
            // The remote command runs, prints and exits after the request returns.
            setTimeout(() => {
                if (this.stderr) {
                    this.extendedData$.next([1, Buffer.from(this.stderr, 'utf8')])
                }
                if (output) {
                    this.data$.next(Buffer.from(output, 'utf8'))
                }
                if (this.sendsEof) {
                    this.eof$.next()
                }
                this.closed$.next()
            }, this.runMs)
        }
    }

    async write (): Promise<void> {}

    async close (): Promise<void> {
        this.closeCalls++
    }
}

function fakeSession (channel: FakeRusshChannel): SshSessionLike & { refs: number } {
    const session = {
        refs: 0,
        willDestroy$: new Subject<void>(),
        ssh: {
            openSessionChannel: async () => ({}),
            activateChannel: async () => channel,
        },
        ref: () => { session.refs++ },
        unref: () => { session.refs-- },
    }
    return session
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    vi.useRealTimers()
})

/** Let pending timers, promise callbacks and unhandled-rejection checks run. */
async function drain (): Promise<void> {
    await vi.advanceTimersByTimeAsync(20_000)
    vi.useRealTimers()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
}

describe('SshControlTransport.readTmuxVersion', () => {
    it('returns the trimmed output of tmux -V and closes the channel', async () => {
        vi.useFakeTimers()
        const ch = new FakeRusshChannel()
        const transport = new SshControlTransport(fakeSession(ch))
        const version = transport.readTmuxVersion()
        await vi.advanceTimersByTimeAsync(0)
        await expect(version).resolves.toBe('tmux 3.5a')
        expect(ch.execs).toEqual(['tmux -V 2>&1'])
        expect(ch.closeCalls).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
        await drain()
        expect(unhandled).toEqual([])
    })

    it('when requestExec rejects: rethrows, closes the channel, clears the timer, no unhandled rejection', async () => {
        vi.useFakeTimers()
        const ch = new FakeRusshChannel()
        ch.execError = new Error('exec refused')
        const transport = new SshControlTransport(fakeSession(ch))
        await expect(transport.readTmuxVersion()).rejects.toThrow('exec refused')
        expect(ch.closeCalls).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
        await drain()
        expect(unhandled).toEqual([])
    })

    it('times out when the command never finishes, and closes the channel', async () => {
        vi.useFakeTimers()
        const ch = new FakeRusshChannel()
        ch.output = null
        const transport = new SshControlTransport(fakeSession(ch))
        const version = transport.readTmuxVersion().catch((e: Error) => e)
        await vi.advanceTimersByTimeAsync(9_999)
        expect(ch.closeCalls).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(((await version) as Error).message).toBe('tmux -V did not answer in time')
        expect(ch.closeCalls).toBe(1)
        await drain()
        expect(unhandled).toEqual([])
    })

    it('when tmux -V prints nothing: rejects naming the stderr text, whether EOF came and how long the channel lived', async () => {
        vi.useFakeTimers()
        const ch = new FakeRusshChannel()
        ch.output = ''
        ch.stderr = 'zsh:1: no such file or directory: /opt/x\n'
        ch.sendsEof = false
        ch.runMs = 42
        const transport = new SshControlTransport(fakeSession(ch))
        const version = transport.readTmuxVersion().catch((e: Error) => e)
        await vi.advanceTimersByTimeAsync(42)
        expect(((await version) as Error).message).toBe(
            'no output; stderr: "zsh:1: no such file or directory: /opt/x"; EOF: no; channel closed after 42 ms')
        expect(ch.closeCalls).toBe(1)
        await drain()
        expect(unhandled).toEqual([])
    })

    it('when tmux -V prints nothing and stderr is empty: still says so', async () => {
        vi.useFakeTimers()
        const ch = new FakeRusshChannel()
        ch.output = ''
        const transport = new SshControlTransport(fakeSession(ch))
        const version = transport.readTmuxVersion().catch((e: Error) => e)
        await vi.advanceTimersByTimeAsync(0)
        expect(((await version) as Error).message).toBe('no output; stderr: ""; EOF: yes; channel closed after 0 ms')
    })

    it('rejects when the SSH connection is not logged in', async () => {
        const session = { ...fakeSession(new FakeRusshChannel()), ssh: null }
        await expect(new SshControlTransport(session).readTmuxVersion()).rejects.toThrow('not logged in')
    })
})

describe('SshControlTransport.openControlChannel', () => {
    it('requests a PTY and runs tmux -CC new-session -A with the escaped name', async () => {
        const ch = new FakeRusshChannel()
        ch.output = null
        const transport = new SshControlTransport(fakeSession(ch))
        await expect(transport.openControlChannel("it's main")).resolves.toBe(ch)
        expect(ch.ptys).toEqual(['xterm-256color'])
        expect(ch.execs).toEqual(["tmux -CC new-session -A -s 'it'\\''s main'"])
        expect(ch.closeCalls).toBe(0)
    })

    it('closes the channel when requestPTY rejects', async () => {
        const ch = new FakeRusshChannel()
        ch.ptyError = new Error('pty refused')
        const transport = new SshControlTransport(fakeSession(ch))
        await expect(transport.openControlChannel('main')).rejects.toThrow('pty refused')
        expect(ch.execs).toEqual([])
        expect(ch.closeCalls).toBe(1)
    })

    it('closes the channel when requestExec rejects', async () => {
        const ch = new FakeRusshChannel()
        ch.execError = new Error('exec refused')
        const transport = new SshControlTransport(fakeSession(ch))
        await expect(transport.openControlChannel('main')).rejects.toThrow('exec refused')
        expect(ch.closeCalls).toBe(1)
    })

    it('still rethrows the request error when close also fails', async () => {
        const ch = new FakeRusshChannel()
        ch.execError = new Error('exec refused')
        ch.close = async () => {
            ch.closeCalls++
            throw new Error('close failed')
        }
        const transport = new SshControlTransport(fakeSession(ch))
        await expect(transport.openControlChannel('main')).rejects.toThrow('exec refused')
        expect(ch.closeCalls).toBe(1)
    })
})

describe('SshControlTransport hold/release', () => {
    it('maps hold and release to ref and unref', () => {
        const session = fakeSession(new FakeRusshChannel())
        const transport = new SshControlTransport(session)
        transport.hold()
        transport.hold()
        transport.release()
        expect(session.refs).toBe(1)
    })
})
