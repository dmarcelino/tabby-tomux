// SPDX-License-Identifier: GPL-3.0-only
//
// Ported from tmux-integrated src/tmuxControlClient.ts at commit 0f92f4a, plus
// pieces of src/extension.ts, src/tmuxTerminalProvider.ts and src/windowTitle.ts.
// Copyright (C) the tmux-integrated authors
//
// Changes: no node-pty/PTY/VS Code; typed operations only, on a transport-free gateway;
// list-windows name field last; captureWithCursor; activity-aware ping (see 'tomux:' notes).

/**
 * TmuxControlClient
 *
 * Typed tmux operations on top of a TmuxGateway connected to `tmux -CC`.  In
 * control mode tmux does not render any UI to the terminal; instead it sends
 * structured protocol messages on stdout and accepts commands on stdin.  This
 * lets tomux own the visual layer (Tabby tabs) while tmux provides session
 * persistence and process management.
 *
 * Protocol summary (https://man.openbsd.org/tmux.1#CONTROL_MODE):
 *   • Unsolicited notifications start with %:
 *       %output %<pane> <escaped-data>
 *       %window-add @<id>
 *       %window-close @<id>
 *       %sessions-changed
 *       %session-changed $<id> <name>
 *       %exit [reason]
 *   • Command responses are wrapped in a begin/end block:
 *       %begin <time> <num> 0
 *       [optional response lines]
 *       %end <time> <num> 0   |   %error <time> <num> 0
 *
 * Architecture:
 *   TmuxGateway       — protocol parsing, %begin/%end handling, command queuing,
 *                       command flags (TolerateErrors), command batching, write
 *                       queuing (defers writes until %session-changed).
 *   TmuxControlClient — high-level typed commands (newWindow, listWindows, …),
 *                       readiness probe, version gating.  The transport (the
 *                       SSH channel) and its lifecycle belong to the connection
 *                       layer, which feeds the gateway and listens to its events.
 */

import { TmuxGateway, CommandFlags, SendCommandOptions, SendCommandListOptions } from './gateway';
import type { PaneBorderStatus } from './layout';

export type {
    TmuxPaneOutput,
    TmuxLayoutChange,
    TmuxWindowPaneChange,
    TmuxWindowRenamed,
    TmuxSessionWindowChange,
    TmuxGatewayEvents,
    TmuxWriter,
    SendCommandOptions,
    SendCommandListOptions,
} from './gateway';
export { TmuxGateway, CommandFlags } from './gateway';

export interface TmuxWindow {
    id: string;
    index: number;
    name: string;
    paneId: string;
    active: boolean;
    /** From `#{automatic-rename}` — when true, tmux (not the user) owns the title. */
    automaticRename: boolean;
    /**
     * tomux: the window's `@tomux-order` user option, its tab position as last
     * recorded by tomux (change restore-tab-order). Null when unset or not a
     * non-negative integer (including on a tmux that cannot report it).
     */
    order: number | null;
}

export interface TmuxPaneCursor {
    x: number;
    y: number;
}

/** tomux: `#{pane_title}` and `#{host}` of a pane, as tmux reports them. */
export interface TmuxPaneTitle {
    host: string;
    title: string;
}

export interface TmuxVersion {
    major: number;
    minor: number;
}

/** tomux: result of `captureWithCursor`. */
export interface TmuxPaneCapture {
    /**
     * History and screen with escapes, lines joined with '\n' (as
     * `capturePane`). For a pane in the alternate screen, the history and the
     * screen tmux keeps behind the program (the shell's screen).
     */
    text: string;
    /** The cursor (the program's cursor when the pane is in the alternate screen). */
    cursorX: number;
    cursorY: number;
    /** The pane's size when it was captured (0 when unknown). */
    paneWidth: number;
    paneHeight: number;
    /** tomux: the height of the pane's window when it was captured (0 when unknown). */
    windowHeight: number;
    /** Present when the pane's program is in the alternate screen. */
    alternate?: TmuxAlternateScreen;
    /** Terminal modes tmux reports for the pane. */
    modes: TmuxPaneModes;
}

/** tomux: the alternate screen of a pane, as captured. */
export interface TmuxAlternateScreen {
    /** The program's screen with escapes, lines joined with '\n'. */
    text: string;
    /** Where tmux puts the cursor when the program leaves the alternate screen; null when none was saved. */
    savedCursor: TmuxPaneCursor | null;
}

/** tomux: cursor visibility and mouse reporting, as tmux reports them for a pane. */
export interface TmuxPaneModes {
    cursorVisible: boolean;
    /** Mouse tracking mode (DECSET 1000, 1002 or 1003), or null when off. */
    mouseMode: 1000 | 1002 | 1003 | null;
    /** Mouse encoding (DECSET 1005 UTF-8 or 1006 SGR), or null for the default. */
    mouseEncoding: 1005 | 1006 | null;
}

/** tomux: options for `ping`. */
export interface TmuxPingOptions {
    /**
     * Time (Date.now()) the channel last delivered any bytes.  When given, the
     * ping deadline moves to `timeoutMs` after the latest activity, so a busy
     * connection (a backlog of replies, streaming output) is not declared dead.
     */
    lastActivityAt?: () => number;
    /** Absolute cap on the wait when activity keeps extending it.  Default 60 s. */
    maxWaitMs?: number;
}

const DEFAULT_PING_MAX_WAIT_MS = 60_000;

/** Response line of the readiness probe sent after the initial handshake. */
const READY_PROBE = '__tomux_ready__';
/** Response line of the health-check ping. */
const PING_PROBE = '__ping__';

/** tomux: the window user option holding a window's recorded tab position (change restore-tab-order). */
export const TOMUX_ORDER_OPTION = '@tomux-order';

export class TmuxControlClient {
    private _version: TmuxVersion | null = null;

    constructor(readonly gateway: TmuxGateway) {}

    // -----------------------------------------------------------------------
    // Version
    // -----------------------------------------------------------------------

    /**
     * Parse a tmux version string (the output of `tmux -V`, e.g. "tmux 3.4")
     * and store the result, so that version-gated features can be checked at
     * runtime.  Unparseable strings leave the stored version unchanged.
     */
    setVersion(versionString: string): void {
        const parsed = parseTmuxVersion(versionString);
        if (parsed) {
            this._version = parsed;
        }
    }

    /** Return the parsed tmux version, or null if not yet resolved. */
    get version(): TmuxVersion | null {
        return this._version;
    }

    /** True when the running tmux is at least the given major.minor. */
    versionAtLeast(major: number, minor: number): boolean {
        return versionAtLeast(this._version, major, minor);
    }

    // -----------------------------------------------------------------------
    // Readiness
    // -----------------------------------------------------------------------

    /**
     * Resolve once tmux control mode answers commands.
     *
     * Call before feeding the first bytes into the gateway.  After the initial
     * %begin/%end handshake the gateway emits '_initial-handshake'.  Only then
     * do we send the readiness probe so that it is the very first command in
     * the write queue and is flushed (along with any other queued commands)
     * once %session-changed arrives.
     */
    awaitReady(timeoutMs = 10_000): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err?: Error): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                this.gateway.removeListener('_initial-handshake', probe);
                if (err) { reject(err); } else { resolve(); }
            };
            const probe = (): void => {
                this.gateway.sendCommand(`display-message -p "${READY_PROBE}"`)
                    .then((lines) => {
                        if (lines[0]?.trim() === READY_PROBE) {
                            finish();
                            return;
                        }
                        finish(new Error(
                            `Unexpected tmux readiness response: ${JSON.stringify(lines)}`,
                        ));
                    })
                    .catch((err) => {
                        finish(err instanceof Error ? err : new Error(String(err)));
                    });
            };
            const timer = setTimeout(() => {
                finish(new Error('Timed out waiting for tmux control mode handshake'));
            }, timeoutMs);

            if (this.gateway.isHandshakeDone) {
                probe();
            } else {
                this.gateway.once('_initial-handshake', probe);
            }
        });
    }

    /**
     * Verify the control-mode connection is actually alive: send a probe and
     * expect it back within `timeoutMs`.  Resolves false on timeout, error or
     * an unexpected response; never rejects.
     *
     * tomux: with `opts.lastActivityAt`, the timeout counts from the latest
     * data received rather than from the send: tmux answers in order, so a
     * probe queued behind a large backlog is late but the connection is fine.
     * The wait is capped at `opts.maxWaitMs` (default 60 s).
     */
    async ping(timeoutMs = 5_000, opts: TmuxPingOptions = {}): Promise<boolean> {
        const { lastActivityAt } = opts;
        const maxWaitMs = opts.maxWaitMs ?? DEFAULT_PING_MAX_WAIT_MS;
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const probe = await Promise.race([
                this.sendCommand(`display-message -p "${PING_PROBE}"`),
                new Promise<never>((_, reject) => {
                    const check = (): void => {
                        const lastActivity = Math.max(started, lastActivityAt?.() ?? started);
                        const deadline = Math.min(lastActivity + timeoutMs, started + maxWaitMs);
                        const now = Date.now();
                        if (now >= deadline) {
                            reject(new Error('health-check timeout'));
                            return;
                        }
                        timer = setTimeout(check, deadline - now);
                    };
                    check();
                }),
            ]);
            return probe[0]?.trim() === PING_PROBE;
        } catch {
            return false;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    /**
     * Send a single tmux command and return the response lines.
     *
     * Delegates to TmuxGateway, which queues the write if the session is not
     * yet ready and supports the TolerateErrors flag.
     */
    sendCommand(
        command: string,
        flags: number = CommandFlags.None,
        opts?: SendCommandOptions,
    ): Promise<string[]> {
        return this.gateway.sendCommand(command, flags, opts);
    }

    /**
     * Send multiple tmux commands as a single batched write.
     *
     * Commands are joined with ' ; ' and sent as one line.  tmux generates
     * one %begin/%end response pair per command.  Use this for atomic
     * multi-step operations (e.g. resize + list-windows) to reduce
     * round-trips.
     *
     * Returns a Promise that resolves to an array of response-line arrays,
     * one per input command.  tomux: tmux stops the line at the first failing
     * command; see TmuxGateway.sendCommandList for how the rest settle.
     */
    sendCommandList(
        commands: string[],
        flags: number = CommandFlags.None,
        opts?: SendCommandListOptions,
    ): Promise<string[][]> {
        return this.gateway.sendCommandList(commands, flags, opts);
    }

    /** Create a new window in the current session. Returns its window and pane IDs. */
    async newWindow(options: {
        name?: string;
        startDirectory?: string;
        shell?: string;
    } = {}): Promise<{ windowId: string; paneId: string; windowIndex: number }> {
        let cmd = 'new-window -P -F "#{window_id} #{pane_id} #{window_index}"';

        if (options.name) {
            cmd += ` -n ${shellescape(options.name)}`;
        }
        if (options.startDirectory) {
            cmd += ` -c ${shellescape(options.startDirectory)}`;
        }
        // Per-window environment via -e is intentionally not supported, for
        // compatibility with older tmux versions.
        if (options.shell) {
            cmd += ` ${shellescape(options.shell)}`;
        }

        const result = await this.sendCommand(cmd);
        const parts = (result[0] ?? '').trim().split(' ');
        if (parts.length < 3 || !parts[0].startsWith('@') || !parts[1].startsWith('%')) {
            throw new Error(`Unexpected new-window response: ${result[0] ?? '(empty)'}`);
        }
        return { windowId: parts[0], paneId: parts[1], windowIndex: Number.parseInt(parts[2] ?? '0', 10) };
    }

    /**
     * tomux: #{window_name} is the last field and everything after the sixth
     * '|' is the name, so a name containing '|' cannot shift the other fields
     * (the original put the name third).  An empty #{automatic-rename} (an old
     * tmux that does not know the option as a format) counts as on, as a
     * missing field did in the original.  #{@tomux-order} is the tab order
     * tomux recorded (see `parseWindowOrder`).
     */
    async listWindows(): Promise<TmuxWindow[]> {
        const res = await this.sendCommand(
            `list-windows -F "#{window_id}|#{window_index}|#{pane_id}|#{window_active}|#{automatic-rename}|#{${TOMUX_ORDER_OPTION}}|#{window_name}"`,
        );
        return res
            .filter((l) => l.trim())
            .map((l) => {
                const parts = l.split('|');
                const [id, indexStr, paneId, active, autoField, orderField] = parts;
                return {
                    id,
                    index: Number.parseInt(indexStr ?? '0', 10),
                    name: parts.slice(6).join('|'),
                    paneId,
                    active: active?.trim() === '1',
                    automaticRename: (autoField ?? '').trim() === '' ? true : tmuxAutomaticRenameIsOn(autoField),
                    order: parseWindowOrder(orderField),
                };
            })
            .filter((w) => Boolean(w.id?.startsWith('@')));
    }

    async killWindow(windowId: string, flags: number = CommandFlags.None): Promise<void> {
        await this.sendCommand(`kill-window -t ${windowId}`, flags);
    }

    /**
     * Apply an explicit (user-chosen) name to the tmux window: pin the name
     * by turning automatic-rename off, then rename.  Batched into a single
     * write so the two commands cannot interleave with others.  Errors are
     * tolerated; the promise only rejects if the connection goes away.
     */
    async renameWindow(windowId: string, name: string): Promise<void> {
        await this.sendCommandList(
            [
                `set-option -w -t ${windowId} automatic-rename off`,
                `rename-window -t ${windowId} ${shellescape(name)}`,
            ],
            CommandFlags.TolerateErrors,
        );
    }

    /**
     * tomux: record `order` as the window's tab position in the window user
     * option `@tomux-order` (change restore-tab-order).  Errors are tolerated:
     * a tmux that refuses the option just keeps window-number order.
     */
    async setWindowOrder(windowId: string, order: number): Promise<void> {
        await this.sendCommand(`set-option -w -t ${windowId} ${TOMUX_ORDER_OPTION} ${order}`, CommandFlags.TolerateErrors);
    }

    /** Make `windowId` tmux's current window. Errors are tolerated. */
    async selectWindow(windowId: string): Promise<void> {
        await this.sendCommand(`select-window -t ${windowId}`, CommandFlags.TolerateErrors);
    }

    /**
     * Resize the tmux client to match the Tabby terminal dimensions.
     *
     * Uses only `refresh-client -C` (available since tmux 2.1) to set the
     * control-mode client size.  The control channel's own PTY is never
     * resized, so tmux protocol lines (which can be very long for complex
     * zsh prompts) are never affected by PTY output processing.
     *
     * iTerm2 similarly relies on `refresh-client -C` for sizing without
     * resizing the control channel PTY to match each pane.
     */
    async refreshClient(cols: number, rows: number): Promise<void> {
        // refresh-client -C sets the control-mode client size.  Available
        // since tmux 2.1; tolerates errors on truly ancient builds.
        await this.sendCommand(
            `refresh-client -C ${cols},${rows}`,
            CommandFlags.TolerateErrors,
        );
    }

    /**
     * Capture pane contents.  For adoption, pass
     * `{ includeEscapeSequences: true, startLine: '-' }` to get the full
     * history plus the visible screen with colours and attributes.
     */
    async capturePane(paneId: string, options: {
        includeEscapeSequences?: boolean;
        includePendingOnly?: boolean;
        alternateScreen?: boolean;
        joinWrappedLines?: boolean;
        startLine?: number | '-';
    } = {}): Promise<string> {
        let cmd = `capture-pane -p -t ${paneId}`;

        if (options.includeEscapeSequences) {
            cmd += ' -e';
        }
        if (options.includePendingOnly) {
            cmd += ' -P';
        }
        if (options.alternateScreen) {
            cmd += ' -a';
        }
        if (options.joinWrappedLines) {
            cmd += ' -J';
        }
        if (options.startLine !== undefined) {
            cmd += ` -S ${options.startLine}`;
        }

        const res = await this.sendCommand(cmd);
        return res.join('\n');
    }

    /**
     * tomux: capture a pane for adoption (history and screen with escapes,
     * wrapped lines joined) together with its cursor position and modes.
     * The captures and the state query of one attempt go out as one line, so
     * tmux runs them back to back without processing pane output in between:
     * the state belongs to the captured screens. `onCaptureStart` runs when
     * each line's first capture's %begin is parsed; any %output parsed after
     * it is newer than the capture.
     *
     * A pane in the alternate screen takes a second line that captures the
     * screen behind the program (`-a`), the history and the program's screen.
     * If the program left the alternate screen in between, `-a` fails and the
     * capture starts again; after `MAX_ALTERNATE_ATTEMPTS` failures a fresh
     * first line is returned as a normal pane. The first line's capture is
     * not reused, because the failed `-a`'s %begin already ran
     * `onCaptureStart`.
     */
    async captureWithCursor(
        paneId: string,
        opts: { onCaptureStart?: () => void } = {},
    ): Promise<TmuxPaneCapture> {
        for (let failures = 0; failures < MAX_ALTERNATE_ATTEMPTS; failures++) {
            const first = await this.captureScreenLine(paneId, opts.onCaptureStart);
            if (!first.alternateOn) {
                return first.capture;
            }
            try {
                return await this.captureBothScreensLine(paneId, opts.onCaptureStart);
            } catch {
                // The program left the alternate screen (or the pane is gone,
                // which the next first line reports): start again.
            }
        }
        return (await this.captureScreenLine(paneId, opts.onCaptureStart)).capture;
    }

    /** History and screen as one capture, with the pane's state. */
    private async captureScreenLine(
        paneId: string,
        onCaptureStart: (() => void) | undefined,
    ): Promise<{ capture: TmuxPaneCapture; alternateOn: boolean }> {
        const [capture, stateReply] = await this.sendCommandList(
            [
                `capture-pane -p -e -J -S - -t ${paneId}`,
                `display-message -p -t ${paneId} "${CAPTURE_STATE_FORMAT}"`,
            ],
            CommandFlags.None,
            { onBegin: (index) => { if (index === 0) { onCaptureStart?.(); } } },
        );
        const state = parseCaptureState(stateReply[0]);
        return { capture: { text: capture.join('\n'), ...state.capture }, alternateOn: state.alternateOn };
    }

    /** The screen behind the program, the history and the program's screen, with the pane's state. */
    private async captureBothScreensLine(
        paneId: string,
        onCaptureStart: (() => void) | undefined,
    ): Promise<TmuxPaneCapture> {
        const [saved, history, screen, stateReply] = await this.sendCommandList(
            [
                `capture-pane -p -e -J -a -t ${paneId}`,
                `capture-pane -p -e -J -S - -E -1 -t ${paneId}`,
                `capture-pane -p -e -J -t ${paneId}`,
                `display-message -p -t ${paneId} "${CAPTURE_STATE_FORMAT}"`,
            ],
            CommandFlags.None,
            { onBegin: (index) => { if (index === 0) { onCaptureStart?.(); } } },
        );
        const state = parseCaptureState(stateReply[0]);
        // With no history, tmux answers `-S - -E -1` with the first screen line.
        const lines = state.historySize > 0 ? [...history, ...saved] : saved;
        return {
            text: lines.join('\n'),
            ...state.capture,
            alternate: { text: screen.join('\n'), savedCursor: state.savedCursor },
        };
    }

    async getPaneCursor(paneId: string): Promise<TmuxPaneCursor> {
        const res = await this.sendCommand(
            `display-message -p -t ${paneId} "#{cursor_x} #{cursor_y}"`,
        );
        return parseCursor(res[0]);
    }

    /**
     * tomux: the pane's current working directory (`#{pane_current_path}`),
     * or null when tmux doesn't know it.  Only the final line ending is
     * stripped, so a path with leading or trailing spaces stays intact, and a
     * directory name containing a newline (which tmux prints as several
     * reply lines) comes back whole.  Rejects when the command fails (for
     * example, the pane is gone).
     */
    async paneCurrentPath(paneId: string): Promise<string | null> {
        const res = await this.sendCommand(
            `display-message -p -t ${paneId} "#{pane_current_path}"`,
        );
        const path = res.join('\n').replace(/[\r\n]+$/u, '');
        return path.trim() ? path : null;
    }

    /**
     * tomux: where tmux draws the status line in the pane borders of
     * `paneId`'s window (`pane-border-status`); 'off' for anything else.
     */
    async paneBorderStatus(paneId: string): Promise<PaneBorderStatus> {
        const res = await this.sendCommand(`display-message -p -t ${paneId} "#{pane-border-status}"`);
        const value = (res[0] ?? '').trim();
        return value === 'top' || value === 'bottom' ? value : 'off';
    }

    /**
     * tomux: the title a program set for `paneId` (OSC 0/2, `#{pane_title}`)
     * and `#{host}`, which tmux uses as the title of a pane no program has
     * titled.  The title is the last field, so a '|' in it cannot shift the
     * host.
     */
    async getPaneTitle(paneId: string): Promise<TmuxPaneTitle> {
        const res = await this.sendCommand(
            `display-message -p -t ${paneId} "#{host}|#{pane_title}"`,
        );
        const line = res[0] ?? '';
        const sep = line.indexOf('|');
        return sep === -1
            ? { host: line, title: '' }
            : { host: line.slice(0, sep), title: line.slice(sep + 1) };
    }

    /** Remove the incremental UTF-8 decoder for a closed pane. */
    removePaneDecoder(paneId: string): void {
        this.gateway.removePaneDecoder(paneId);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the output of `tmux -V` ("tmux 3.5a", "tmux next-3.6", "tmux 2.1")
 * into major.minor.  Letter suffixes and prefixes are ignored.  Returns null
 * when no `<major>.<minor>` is present (e.g. "tmux master").
 */
export function parseTmuxVersion(versionString: string): TmuxVersion | null {
    const match = /(\d+)\.(\d+)/u.exec(versionString);
    if (!match) {
        return null;
    }
    return { major: Number(match[1]), minor: Number(match[2]) };
}

/** True when `version` is at least major.minor; false when it is unknown. */
export function versionAtLeast(version: TmuxVersion | null, major: number, minor: number): boolean {
    if (!version) { return false; }
    return version.major > major ||
        (version.major === major && version.minor >= minor);
}

/**
 * tomux: the pane state `captureWithCursor` reads with each capture. Fields
 * are separated by '|' so an empty one (a format an old tmux doesn't know)
 * keeps its place.
 */
const CAPTURE_STATE_FORMAT = [
    'cursor_x', 'cursor_y', 'pane_width', 'pane_height',
    'alternate_on', 'alternate_saved_x', 'alternate_saved_y', 'history_size',
    'cursor_flag', 'mouse_standard_flag', 'mouse_button_flag', 'mouse_all_flag', 'mouse_sgr_flag', 'mouse_utf8_flag',
    'window_height',
].map(name => `#{${name}}`).join('|');

/** tomux: second lines tried before a capture falls back to a normal pane. */
const MAX_ALTERNATE_ATTEMPTS = 3;

function parseCaptureState(line: string | undefined): {
    capture: Omit<TmuxPaneCapture, 'text' | 'alternate'>;
    alternateOn: boolean;
    savedCursor: TmuxPaneCursor | null;
    historySize: number;
} {
    const fields = (line ?? '').trim().split('|');
    const num = (index: number): number => Number.parseInt(fields[index] ?? '', 10) || 0;
    const flag = (index: number): boolean => fields[index] === '1';
    const [paneWidth, paneHeight] = [num(2), num(3)];
    const savedX = Number.parseInt(fields[5] ?? '', 10);
    const savedY = Number.parseInt(fields[6] ?? '', 10);
    // tmux reports UINT_MAX when no cursor was saved (the program used ?47h).
    const savedInPane = savedX >= 0 && savedY >= 0 && savedX <= paneWidth && savedY < paneHeight;
    return {
        capture: {
            cursorX: num(0),
            cursorY: num(1),
            paneWidth,
            paneHeight,
            windowHeight: num(14),
            modes: {
                // An empty field (unknown format) counts as shown.
                cursorVisible: fields[8] !== '0',
                mouseMode: flag(11) ? 1003 : flag(10) ? 1002 : flag(9) ? 1000 : null,
                mouseEncoding: flag(12) ? 1006 : flag(13) ? 1005 : null,
            },
        },
        alternateOn: flag(4),
        savedCursor: savedInPane ? { x: savedX, y: savedY } : null,
        historySize: num(7),
    };
}

/** "<x> <y>" from `display-message -p "#{cursor_x} #{cursor_y}"`; unparseable parts are 0. */
function parseCursor(line: string | undefined): TmuxPaneCursor {
    const [xText, yText] = (line ?? '').trim().split(/\s+/u);
    return {
        x: Number.parseInt(xText ?? '0', 10) || 0,
        y: Number.parseInt(yText ?? '0', 10) || 0,
    };
}

/** tomux: a `#{@tomux-order}` value as a non-negative integer, or null (unset, garbage, or an old tmux). */
export function parseWindowOrder(field: string | undefined): number | null {
    const v = (field ?? '').trim();
    return /^\d+$/u.test(v) ? Number.parseInt(v, 10) : null;
}

/** Interpret `#{automatic-rename}` / `list-windows` field (version-dependent values). */
export function tmuxAutomaticRenameIsOn(value: string | undefined): boolean {
    const v = (value ?? '').trim().toLowerCase();
    return v === '1' || v === 'on' || v === 'yes' || v === 'true';
}

/**
 * Minimal shell-escaping: wrap value in single quotes and escape any
 * single quotes inside it.  Safe for passing to tmux command strings.
 */
export function shellescape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
