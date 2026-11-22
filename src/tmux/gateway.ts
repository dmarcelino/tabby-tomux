// SPDX-License-Identifier: GPL-3.0-only
//
// Ported from tmux-integrated src/tmuxGateway.ts at commit 0f92f4a.
// Copyright (C) the tmux-integrated authors
//
// Changes: transport-free, DCS/ST framing fixed, block parsing hardened,
// command lists settled as a group, closed state, per-command begin hook
// (see 'tomux:' notes).

/**
 * TmuxGateway — low-level tmux control-mode protocol parser and command dispatcher.
 *
 * Modelled on iTerm2's TmuxGateway design, this class cleanly separates
 * the protocol parsing layer from higher-level business logic (TmuxControlClient).
 *
 * Responsibilities:
 *   - Parse %begin/%end/%error response blocks and dispatch to the command queue.
 *   - Parse asynchronous %notifications and emit them as events.
 *   - Support command flags:
 *       • TolerateErrors — resolve with [] on %error instead of rejecting.
 *   - Support command batching (sendCommandList) to reduce PTY round-trips:
 *       commands are joined with ' ; ' and sent as a single write, with one
 *       pending-queue entry per command to match the individual responses.
 *       tomux: tmux stops a line at the first command that fails: that
 *       command gets %error and the later ones get no block at all, so they
 *       are settled at once (see `skipRestOfGroup`).
 *   - tomux: closed state. After %exit or `close()` every pending command is
 *       rejected and new commands reject at once instead of waiting forever.
 *   - Write queuing: all outgoing writes are deferred until %session-changed is
 *       received, preventing races during the tmux control-mode init sequence.
 *       A setImmediate fallback ensures compatibility with tmux < 2.6, which
 *       does not emit %session-changed.
 *
 * Transport (tomux): the gateway owns no channel or process. Feed every byte
 * the control channel produces into `ingest()`, and supply a writer (in the
 * constructor or via `setWriter()`) that sends a string to the channel. The
 * writer receives JavaScript strings (one command line terminated by `\r`
 * per write); the transport is responsible for encoding them as UTF-8.
 *
 * Framing: `tmux -CC` wraps the whole stream in a DCS string. The first bytes
 * are the introducer `ESC P 1000 p`, immediately followed by the first
 * `%begin`; after `%exit` the stream ends with ST (`ESC \`), usually without a
 * trailing newline. Lines end in `\r\n` when the channel has a PTY. Neither
 * the introducer, the terminator nor the `\r` reach the protocol parser.
 */

import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

// ---------------------------------------------------------------------------
// Command flags
// ---------------------------------------------------------------------------

/** Bit flags controlling per-command gateway behaviour. */
export const CommandFlags = {
    None: 0,
    /**
     * When set, a %error response resolves the promise with an empty array
     * instead of rejecting it.  Use for fire-and-forget operations where
     * failure is expected and the caller wants to proceed regardless.
     */
    TolerateErrors: 1 << 0,
} as const;

/** Union of all valid CommandFlags values. */
export type CommandFlagsValue = typeof CommandFlags[keyof typeof CommandFlags];

// ---------------------------------------------------------------------------
// Shared types (re-exported so callers don't need to import from two places)
// ---------------------------------------------------------------------------

export interface TmuxPaneOutput {
    paneId: string;
    data: string;
}

export interface TmuxLayoutChange {
    windowId: string;
    layout: string;
    visibleLayout: string;
    flags: string;
}

export interface TmuxWindowPaneChange {
    windowId: string;
    paneId: string;
}

export interface TmuxWindowRenamed {
    windowId: string;
    name: string;
}

export interface TmuxSessionWindowChange {
    sessionId: string;
    windowId: string;
}

/** Function used to send data to the control channel. */
export type TmuxWriter = (data: string) => void;

/** Events emitted by TmuxGateway, with their listener signatures. */
export interface TmuxGatewayEvents {
    /** Decoded pane output (`%output` / `%extended-output`). */
    'output': (output: TmuxPaneOutput) => void;
    /** `%window-add @id` — the window id. */
    'window-add': (windowId: string) => void;
    /** `%window-close @id` and `%unlinked-window-close @id` — the window id. */
    'window-close': (windowId: string) => void;
    /** `%window-renamed @id name` — null if the line could not be parsed. */
    'window-renamed': (change: TmuxWindowRenamed | null) => void;
    'layout-change': (change: TmuxLayoutChange) => void;
    'window-pane-changed': (change: TmuxWindowPaneChange) => void;
    /** `%session-window-changed $s @w` — null if the line could not be parsed. */
    'session-window-changed': (change: TmuxSessionWindowChange | null) => void;
    /** `%session-renamed` — the rest of the line (`$id name`). */
    'session-renamed': (rest: string) => void;
    'sessions-changed': () => void;
    /** `%session-changed $id name` — the rest of the line, trimmed. */
    'session-changed': (rest: string) => void;
    'pane-mode-changed': (paneId: string) => void;
    'paste-buffer-changed': () => void;
    'pause': (paneId: string) => void;
    'continue': (paneId: string) => void;
    'message': (message: string) => void;
    /** `%exit [reason]` — the reason, or undefined when tmux gave none. */
    'tmux-exit': (reason?: string) => void;
    /** First `%end` with no command of ours in flight: control mode is alive. */
    '_initial-handshake': () => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingCommand {
    flags: number;
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
    // tomux: true once the command's write has reached the writer.  A block
    // that ends while the oldest pending command is still unsent cannot be
    // its response (tmux has not seen the command yet).
    sent: boolean;
    // tomux: called when this command's %begin is parsed.
    onBegin?: () => void;
    // tomux: every entry of the sendCommandList line this command belongs to
    // (in order), or undefined for a single command.
    group?: PendingCommand[];
}

/** tomux: options for `sendCommand`. */
export interface SendCommandOptions {
    /**
     * Called synchronously when the gateway parses this command's `%begin`,
     * before it processes any later line (such as `%output` that tmux sends
     * after the reply).  Not called for a command that never runs.
     */
    onBegin?: () => void;
}

/** tomux: options for `sendCommandList`. */
export interface SendCommandListOptions {
    /** As `SendCommandOptions.onBegin`, with the member's index in the list. */
    onBegin?: (index: number) => void;
}

/** tomux: error message of a command sent after the connection ended. */
export const CONNECTION_ENDED_MESSAGE = 'tmux connection has ended';
/** tomux: error message of a list member tmux skipped after an earlier one failed. */
export const SKIPPED_MESSAGE = 'skipped: an earlier command in the same line failed';

interface QueuedWrite {
    data: string;
    commands: PendingCommand[];
}

// The control-mode parser works on raw bytes so %output payloads are not
// decoded as UTF-8 before pane-level boundary handling. Keep the repeated
// byte markers/prefixes named to make the framing logic readable.
const BYTE_LF = 0x0a;
const BYTE_CR = 0x0d;
const BYTE_ESC = 0x1b;
const BYTE_P = 0x50;
const BYTE_SPACE = 0x20;
const BYTE_BACKSLASH = 0x5c;
const BYTE_COLON = 0x3a;

const OUTPUT_PREFIX = Buffer.from('%output ', 'ascii');
const EXTENDED_OUTPUT_PREFIX = Buffer.from('%extended-output ', 'ascii');
const WINDOW_ADD_PREFIX = '%window-add ';
const WINDOW_CLOSE_PREFIX = '%window-close ';
const UNLINKED_WINDOW_CLOSE_PREFIX = '%unlinked-window-close ';
const WINDOW_RENAMED_PREFIX = '%window-renamed ';
const LAYOUT_CHANGE_PREFIX = '%layout-change ';
const WINDOW_PANE_CHANGED_PREFIX = '%window-pane-changed ';
const SESSION_WINDOW_CHANGED_PREFIX = '%session-window-changed ';
const SESSION_RENAMED_PREFIX = '%session-renamed ';
const SESSION_CHANGED_PREFIX = '%session-changed ';
const PANE_MODE_CHANGED_PREFIX = '%pane-mode-changed ';
const PAUSE_PREFIX = '%pause ';
const CONTINUE_PREFIX = '%continue ';
const MESSAGE_PREFIX = '%message ';
const EXIT_PREFIX = '%exit';

/**
 * Strip the DCS introducer (`ESC P <params> <final>`, `ESC P 1000 p` for
 * tmux -CC) from the start of a line and an ST (`ESC \`) from its end.
 *
 * tomux: the introducer is matched by its ECMA-48 structure (parameter bytes
 * 0x30–0x3f, intermediate bytes 0x20–0x2f, final byte 0x40–0x7e). The
 * original scanned for an 'l' final byte, which tmux never sends, so the
 * introducer was left in place and the first `%begin` went unrecognised.
 */
function stripDcsWrapper(line: Buffer): Buffer {
    let stripped = line;

    if (stripped.length >= 2 && stripped[0] === BYTE_ESC && stripped[1] === BYTE_P) {
        let scan = 2;
        while (scan < stripped.length && stripped[scan] >= 0x30 && stripped[scan] <= 0x3f) {
            scan++;
        }
        while (scan < stripped.length && stripped[scan] >= 0x20 && stripped[scan] <= 0x2f) {
            scan++;
        }
        if (scan < stripped.length && stripped[scan] >= 0x40 && stripped[scan] <= 0x7e) {
            stripped = stripped.subarray(scan + 1);
        }
    }

    if (
        stripped.length >= 2
        && stripped[stripped.length - 2] === BYTE_ESC
        && stripped[stripped.length - 1] === BYTE_BACKSLASH
    ) {
        stripped = stripped.subarray(0, stripped.length - 2);
    }

    return stripped;
}

/** "<time> <number>" from a %begin/%end/%error guard line, or null. */
function blockGuardArgs(line: string): string | null {
    const match = /^%\S+ (\S+) (\S+)/u.exec(line);
    return match ? `${match[1]} ${match[2]}` : null;
}

function hasPrefix(line: Buffer, prefix: Buffer): boolean {
    return line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix);
}

// ---------------------------------------------------------------------------
// TmuxGateway
// ---------------------------------------------------------------------------

// Typed overloads for the gateway's events (merged into the class below).
export interface TmuxGateway {
    on<E extends keyof TmuxGatewayEvents>(event: E, listener: TmuxGatewayEvents[E]): this;
    once<E extends keyof TmuxGatewayEvents>(event: E, listener: TmuxGatewayEvents[E]): this;
    off<E extends keyof TmuxGatewayEvents>(event: E, listener: TmuxGatewayEvents[E]): this;
    removeListener<E extends keyof TmuxGatewayEvents>(event: E, listener: TmuxGatewayEvents[E]): this;
    emit<E extends keyof TmuxGatewayEvents>(event: E, ...args: Parameters<TmuxGatewayEvents[E]>): boolean;
}

export class TmuxGateway extends EventEmitter {
    // Raw-data accumulation buffer.
    private readBuffer = Buffer.alloc(0);

    // Lines accumulated inside a %begin…%end block.
    private responseBuffer: string[] = [];

    // True when we are inside a %begin…%end or %begin…%error block.
    private inBlock = false;

    // tomux: "<time> <number>" of the open block's %begin, used to recognise the
    // matching %end/%error; null when %begin carried no arguments.
    private blockTag: string | null = null;

    // FIFO of in-flight commands waiting for %begin/%end pairs.
    private pendingQueue: PendingCommand[] = [];

    // Writes buffered before %session-changed (or the fallback flush).
    private writeQueue: QueuedWrite[] = [];

    // Becomes true once the write queue has been flushed.
    private sessionReady = false;

    // Set to true after the first %end with an empty pending queue.
    private handshakeDone = false;

    // Function used to write bytes to the underlying channel.
    private writer: TmuxWriter | null = null;

    // Per-pane incremental UTF-8 decoders, keyed by pane ID.
    private readonly paneDecoders = new Map<string, StringDecoder>();

    // tomux: set by %exit or close(); no command is accepted afterwards.
    private closed = false;

    constructor(writer?: TmuxWriter) {
        super();
        if (writer) {
            this.writer = writer;
        }
    }

    // -----------------------------------------------------------------------
    // Public API — setup
    // -----------------------------------------------------------------------

    /**
     * Supply the function used to write to the underlying channel.
     * Must be called (or the writer passed to the constructor) before any
     * data is ingested; writes made while no writer is set are dropped.
     */
    setWriter(fn: TmuxWriter): void {
        this.writer = fn;
    }

    /** True once the initial %begin/%end handshake from tmux was seen. */
    get isHandshakeDone(): boolean {
        return this.handshakeDone;
    }

    /** True once buffered writes have been flushed to tmux. */
    get isSessionReady(): boolean {
        return this.sessionReady;
    }

    /** tomux: true after %exit or `close()`; commands then reject at once. */
    get isClosed(): boolean {
        return this.closed;
    }

    // -----------------------------------------------------------------------
    // Public API — data ingestion
    // -----------------------------------------------------------------------

    /**
     * Feed raw channel data into the parser.
     * Call this from the channel's data callback, with bytes in arrival order.
     */
    ingest(raw: string | Uint8Array): void {
        const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
        this.readBuffer = this.readBuffer.length === 0
            ? chunk
            : Buffer.concat([this.readBuffer, chunk]);

        this.consumeStringTerminator();
        let lineEnd = this.readBuffer.indexOf(BYTE_LF);
        while (lineEnd !== -1) {
            let line = this.readBuffer.subarray(0, lineEnd);
            this.readBuffer = this.readBuffer.subarray(lineEnd + 1);
            if (line.length > 0 && line[line.length - 1] === BYTE_CR) {
                line = line.subarray(0, line.length - 1);
            }
            this.parseLine(line);
            this.consumeStringTerminator();
            lineEnd = this.readBuffer.indexOf(BYTE_LF);
        }
    }

    // -----------------------------------------------------------------------
    // Public API — command dispatch
    // -----------------------------------------------------------------------

    /**
     * Send a single tmux command and return the response lines.
     *
     * If the write queue has not yet been flushed (session not ready), the
     * channel write is deferred and the returned promise will not resolve
     * until %session-changed triggers the flush.
     */
    sendCommand(
        command: string,
        flags: number = CommandFlags.None,
        opts: SendCommandOptions = {},
    ): Promise<string[]> {
        if (this.closed) {
            return Promise.reject(new Error(CONNECTION_ENDED_MESSAGE));
        }
        return new Promise((resolve, reject) => {
            const cmd: PendingCommand = { flags, resolve, reject, sent: false, onBegin: opts.onBegin };
            this.pendingQueue.push(cmd);
            this.write(command + '\r', [cmd]);
        });
    }

    /**
     * Send multiple tmux commands as a single batched write.
     *
     * Commands are joined with ' ; ' and sent as one line.  tmux generates
     * one %begin/%end response pair per command, so N entries are pushed to
     * the pending queue and matched in order as responses arrive.
     *
     * Returns a Promise that resolves to an array of response-line arrays,
     * one per input command, when all responses have been received.
     *
     * tomux: the line is one unit for tmux.  When a member fails, tmux sends
     * its %error and skips every later member without a block, so those are
     * settled at once: rejected with SKIPPED_MESSAGE, or resolved with [] under
     * TolerateErrors.  Without TolerateErrors the list therefore rejects with
     * the failing member's error.
     */
    sendCommandList(
        commands: string[],
        flags: number = CommandFlags.None,
        opts: SendCommandListOptions = {},
    ): Promise<string[][]> {
        if (commands.length === 0) {
            return Promise.resolve([]);
        }
        if (this.closed) {
            return Promise.reject(new Error(CONNECTION_ENDED_MESSAGE));
        }

        const combined = commands.join(' ; ');
        const entries: PendingCommand[] = [];
        const { onBegin } = opts;
        const promises = commands.map(
            (_command, index) => new Promise<string[]>((resolve, reject) => {
                const cmd: PendingCommand = {
                    flags,
                    resolve,
                    reject,
                    sent: false,
                    onBegin: onBegin ? () => onBegin(index) : undefined,
                    group: entries,
                };
                entries.push(cmd);
                this.pendingQueue.push(cmd);
            }),
        );

        this.write(combined + '\r', entries);
        return Promise.all(promises);
    }

    /**
     * Reject all pending commands.
     * Call this when the underlying channel closes or the tmux process exits.
     *
     * tomux: also closes the gateway (see `close()`), so a command sent
     * afterwards rejects at once instead of waiting for a reply that cannot
     * come.
     */
    drainOnExit(): void {
        this.close();
    }

    /**
     * tomux: mark the connection as ended.  Pending commands (including writes
     * still buffered before the session was ready) are rejected with
     * "tmux process exited"; later `sendCommand`/`sendCommandList` calls reject
     * at once with CONNECTION_ENDED_MESSAGE.  Idempotent.
     */
    close(): void {
        this.closed = true;
        this.writeQueue = [];
        const queue = this.pendingQueue.splice(0);
        for (const cmd of queue) {
            cmd.reject(new Error('tmux process exited'));
        }
    }

    /** Remove the incremental UTF-8 decoder for a closed pane. */
    removePaneDecoder(paneId: string): void {
        this.paneDecoders.delete(paneId);
    }

    // -----------------------------------------------------------------------
    // Private — write queuing
    // -----------------------------------------------------------------------

    private write(data: string, commands: PendingCommand[]): void {
        if (this.closed) {
            return;
        }
        if (!this.sessionReady) {
            this.writeQueue.push({ data, commands });
            return;
        }
        this.send({ data, commands });
    }

    private send(item: QueuedWrite): void {
        for (const cmd of item.commands) {
            cmd.sent = true;
        }
        this.writer?.(item.data);
    }

    /**
     * Flush the write queue and mark the session as ready.
     * Idempotent — safe to call multiple times (subsequent calls are no-ops).
     */
    private flushWriteQueue(): void {
        if (this.sessionReady) {
            return;
        }
        this.sessionReady = true;
        const queue = this.writeQueue.splice(0);
        for (const item of queue) {
            this.send(item);
        }
    }

    // -----------------------------------------------------------------------
    // Private — protocol parsing
    // -----------------------------------------------------------------------

    /**
     * Drop an ST (`ESC \`) at the start of the read buffer. The buffer always
     * starts at a line boundary, and control-mode lines never start with ESC
     * other than the DCS introducer, so this is the stream terminator tmux
     * sends after `%exit` (normally with no newline after it).
     */
    private consumeStringTerminator(): void {
        if (
            !this.inBlock
            && this.readBuffer.length >= 2
            && this.readBuffer[0] === BYTE_ESC
            && this.readBuffer[1] === BYTE_BACKSLASH
        ) {
            this.readBuffer = this.readBuffer.subarray(2);
        }
    }

    private parseLine(line: Buffer): void {
        if (this.inBlock) {
            // tomux: inside an output block every line is response text,
            // including empty lines and lines that start with '%' (both occur
            // in capture-pane output).  tmux(1): "A notification will never
            // occur inside an output block."  DCS stripping is skipped too, so
            // a captured line ending in ST (e.g. an OSC 8 link) stays intact.
            this.parseBlockLine(line.toString('utf8'));
            return;
        }

        if (line.length === 0) { return; }

        line = stripDcsWrapper(line);
        if (line.length === 0) {
            return;
        }

        if (hasPrefix(line, OUTPUT_PREFIX)) {
            this.parseOutput(line);
            return;
        }
        if (hasPrefix(line, EXTENDED_OUTPUT_PREFIX)) {
            this.parseExtendedOutput(line);
            return;
        }

        this.parseControlLine(line.toString('utf8'));
    }

    private parseBlockLine(line: string): void {
        if (this.closesBlock(line, '%end')) {
            this.endBlock(line, false);
        } else if (this.closesBlock(line, '%error')) {
            this.endBlock(line, true);
        } else {
            // tomux: the original handed in-block lines starting with '%' to
            // parseNotification ("Asynchronous notifications that arrive while
            // a command block is in flight must be processed as notifications,
            // not swallowed as response text").  tmux never interleaves
            // notifications with a block, so such lines are response text
            // (e.g. a captured pane line "%output …" or a window named "%x").
            this.responseBuffer.push(line);
        }
    }

    private parseControlLine(line: string): void {
        if (line.startsWith('%begin')) {
            this.inBlock = true;
            this.blockTag = blockGuardArgs(line);
            this.responseBuffer = [];
            this.notifyBegin();
        } else if (line.startsWith('%end')) {
            // A %end/%error outside a block is handled as in the original.
            this.endBlock(line, false);
        } else if (line.startsWith('%error')) {
            this.endBlock(line, true);
        } else {
            this.parseNotification(line);
        }
    }

    /**
     * True when `line` is the %end/%error closing the open block.  tmux
     * repeats the %begin's time and command number, so a response line that
     * merely starts with "%end" (captured pane text) does not end the block.
     */
    private closesBlock(line: string, keyword: '%end' | '%error'): boolean {
        if (!line.startsWith(keyword)) {
            return false;
        }
        return this.blockTag === null || blockGuardArgs(line) === this.blockTag;
    }

    /**
     * tomux: run the begin hook of the command that owns the block just
     * opened (the same command `endBlock` will settle), synchronously, before
     * any later line is parsed.  A throwing hook must not corrupt the parser.
     */
    private notifyBegin(): void {
        const cmd = this.pendingQueue[0];
        if (!cmd?.sent || !cmd.onBegin) {
            return;
        }
        try {
            cmd.onBegin();
        } catch (err) {
            console.error('tomux: onBegin callback threw', err);
        }
    }

    /**
     * tomux: after `failed` got %error, tmux skips the rest of its line and
     * sends no block for those commands.  Settle them now and take them out
     * of the queue, so the next block is matched to the right command.
     */
    private skipRestOfGroup(failed: PendingCommand): void {
        const group = failed.group;
        if (!group) {
            return;
        }
        const skipped = group.slice(group.indexOf(failed) + 1);
        if (skipped.length === 0) {
            return;
        }
        this.pendingQueue = this.pendingQueue.filter(cmd => !skipped.includes(cmd));
        for (const cmd of skipped) {
            if (cmd.flags & CommandFlags.TolerateErrors) {
                cmd.resolve([]);
            } else {
                cmd.reject(new Error(SKIPPED_MESSAGE));
            }
        }
    }

    private endBlock(line: string, isError: boolean): void {
        this.inBlock = false;
        this.blockTag = null;
        // tomux: only a command whose write has gone out can own this response.
        const cmd = this.pendingQueue[0]?.sent ? this.pendingQueue.shift() : undefined;
        if (!isError) {
            if (cmd) {
                cmd.resolve(this.responseBuffer.slice());
            } else if (!this.handshakeDone) {
                // The very first %end with no pending command signals that
                // tmux control mode is alive.  Emit the handshake event so
                // TmuxControlClient can now safely queue the readiness probe.
                this.handshakeDone = true;
                this.emit('_initial-handshake');
                // Fallback flush for tmux < 2.6, which does not emit
                // %session-changed.  flushWriteQueue is idempotent, so if
                // %session-changed fires first (in the same ingest call) the
                // setImmediate becomes a no-op.
                setImmediate(() => this.flushWriteQueue());
            }
        } else if (cmd) {
            if (cmd.flags & CommandFlags.TolerateErrors) {
                cmd.resolve([]);
            } else {
                cmd.reject(new Error(this.responseBuffer.join('\n') || line));
            }
            this.skipRestOfGroup(cmd);
        }
        this.responseBuffer = [];
    }

    private parseNotification(line: string): void {
        if (line.startsWith(WINDOW_ADD_PREFIX)) {
            this.emit('window-add', line.slice(WINDOW_ADD_PREFIX.length).trim());
        } else if (line.startsWith(WINDOW_CLOSE_PREFIX) || line.startsWith(UNLINKED_WINDOW_CLOSE_PREFIX)) {
            const prefix = line.startsWith(WINDOW_CLOSE_PREFIX) ? WINDOW_CLOSE_PREFIX : UNLINKED_WINDOW_CLOSE_PREFIX;
            const windowId = line.slice(prefix.length).trim().split(/\s+/u)[0];
            this.emit('window-close', windowId);
        } else if (line.startsWith(WINDOW_RENAMED_PREFIX)) {
            this.emit('window-renamed', parseWindowRenamed(line));
        } else if (line.startsWith(LAYOUT_CHANGE_PREFIX)) {
            const layoutChange = parseLayoutChange(line);
            if (layoutChange) {
                this.emit('layout-change', layoutChange);
            }
        } else if (line.startsWith(WINDOW_PANE_CHANGED_PREFIX)) {
            const paneChange = parseWindowPaneChange(line);
            if (paneChange) {
                this.emit('window-pane-changed', paneChange);
            }
        } else if (line.startsWith(SESSION_WINDOW_CHANGED_PREFIX)) {
            this.emit('session-window-changed', parseSessionWindowChanged(line));
        } else if (line.startsWith(SESSION_RENAMED_PREFIX)) {
            this.emit('session-renamed', line.slice(SESSION_RENAMED_PREFIX.length));
        } else if (line.startsWith('%sessions-changed')) {
            this.emit('sessions-changed');
        } else if (line.startsWith(SESSION_CHANGED_PREFIX)) {
            // %session-changed $N name — the session is now fully initialised.
            // Flush the write queue so deferred commands reach tmux.
            this.flushWriteQueue();
            this.emit('session-changed', line.slice(SESSION_CHANGED_PREFIX.length).trim());
        } else if (line.startsWith(PANE_MODE_CHANGED_PREFIX)) {
            this.emit('pane-mode-changed', line.slice(PANE_MODE_CHANGED_PREFIX.length).trim());
        } else if (line.startsWith('%paste-buffer-changed')) {
            this.emit('paste-buffer-changed');
        } else if (line.startsWith(PAUSE_PREFIX)) {
            this.emit('pause', line.slice(PAUSE_PREFIX.length).trim());
        } else if (line.startsWith(CONTINUE_PREFIX)) {
            this.emit('continue', line.slice(CONTINUE_PREFIX.length).trim());
        } else if (line.startsWith(MESSAGE_PREFIX)) {
            this.emit('message', line.slice(MESSAGE_PREFIX.length));
        } else if (line.startsWith(EXIT_PREFIX)) {
            const reason = line.slice(EXIT_PREFIX.length).trim();
            // tomux: nothing answers after %exit; settle what is pending.
            this.close();
            this.emit('tmux-exit', reason || undefined);
        }
    }

    private parseOutput(line: Buffer): void {
        const rest = line.subarray(OUTPUT_PREFIX.length);
        const sp = rest.indexOf(BYTE_SPACE);
        if (sp === -1) {
            return;
        }

        const paneId = rest.subarray(0, sp).toString('utf8');
        const encoded = rest.subarray(sp + 1);
        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data });
    }

    private parseExtendedOutput(line: Buffer): void {
        const rest = line.subarray(EXTENDED_OUTPUT_PREFIX.length);
        const firstSpace = rest.indexOf(BYTE_SPACE);
        if (firstSpace === -1) {
            return;
        }

        const paneId = rest.subarray(0, firstSpace).toString('utf8');
        if (!paneId.startsWith('%')) {
            return;
        }

        const colonIndex = rest.indexOf(BYTE_COLON);
        if (colonIndex === -1) {
            return;
        }

        let encoded = rest.subarray(colonIndex + 1);
        if (encoded.length > 0 && encoded[0] === BYTE_SPACE) {
            encoded = encoded.subarray(1);
        }

        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data });
    }

    private decodePaneOutput(paneId: string, encoded: Buffer): string {
        let decoder = this.paneDecoders.get(paneId);
        if (!decoder) {
            decoder = new StringDecoder('utf8');
            this.paneDecoders.set(paneId, decoder);
        }

        return decoder.write(decodeOutput(encoded));
    }

}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Decode data from a tmux %output or %extended-output notification.
 *
 * Modelled on iTerm2's `decodeEscapedOutput:` (TmuxGateway.m), but
 * deliberately more conservative about which bare bytes it drops:
 *   - tmux octal-encodes control bytes in the %output payload, but in
 *     practice bare control bytes can still appear (e.g. when tmux passes
 *     through certain terminal protocol responses).  The original iTerm2
 *     guard skipped *all* bytes < 0x20, which strips the leading ESC of
 *     responses like a cursor-position report (`ESC[<row>;<col>R`) and
 *     leaves the visible tail in the terminal — see tmux-integrated issue #26.
 *   - The only documented case the guard was actually targeting is the
 *     bare `\r` that the PTY line driver "sprinkles in at its pleasure"
 *     (e.g. ONLCR converting `\n` → `\r\n`).  We restrict the filter to
 *     that single case and let every other byte — most importantly ESC
 *     (0x1b) — pass through so terminal protocol sequences arrive intact.
 *   - Within an octal escape (\NNN), bare `\r` is similarly ignored,
 *     matching iTerm2's comment: "Ignore \r's that the line driver
 *     sprinkles in at its pleasure."
 */
export function decodeOutput(encoded: Uint8Array): Buffer {
    //  Pre-allocate: decoded length is always <= encoded length (octal escapes
    //  \NNN are 4 input bytes -> one output byte). A single allocUnsafe +
    // slice is cheaper than a buffer
    const out = Buffer.allocUnsafe(encoded.length);
    let writePos = 0;
    for (let index = 0; index < encoded.length; ) {
        const code = encoded[index];

        // Drop bare CR injected by the PTY line driver. Other control
        // bytes (notably ESC 0x1b) must be preserved so that terminal
        // protocol responses such as CPR are not truncated.
        if (code === BYTE_CR) {
            index++;
            continue;
        }

        if (code === BYTE_BACKSLASH) {
            // Try to read exactly 3 octal digits, skipping any bare \r
            // characters the line driver may have inserted.
            let value = 0;
            let digits = 0;
            let scan = index + 1;
            while (digits < 3 && scan < encoded.length) {
                const ch = encoded[scan];
                if (ch === BYTE_CR) {     // bare \r — skip
                    scan++;
                    continue;
                }
                if (ch === undefined || ch < 0x30 || ch > 0x37) {  // not '0'..'7'
                    break;
                }
                value = value * 8 + (ch - 0x30);
                digits++;
                scan++;
            }
            if (digits === 3) {
                out[writePos++] = value;
                index = scan;
                continue;
            }
            // Not a valid octal escape — fall through and emit '\' as-is.
        }

        out[writePos++] = code;
        index++;
    }

    return out.subarray(0, writePos);
}

function parseLayoutChange(line: string): TmuxLayoutChange | null {
    const match = /^%layout-change\s+(@\S+)\s+(\S+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, layout, visibleLayout, flags] = match;
    return { windowId, layout, visibleLayout, flags: flags.trim() };
}

function parseWindowPaneChange(line: string): TmuxWindowPaneChange | null {
    const match = /^%window-pane-changed\s+(@\S+)\s+(%\S+)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, paneId] = match;
    return { windowId, paneId };
}

function parseWindowRenamed(line: string): TmuxWindowRenamed | null {
    const match = /^%window-renamed\s+(@\S+)\s+(.*)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, name] = match;
    return { windowId, name };
}

function parseSessionWindowChanged(line: string): TmuxSessionWindowChange | null {
    const match = /^%session-window-changed\s+(\$\S+)\s+(@\S+)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, sessionId, windowId] = match;
    return { sessionId, windowId };
}
