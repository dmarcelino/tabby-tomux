// SPDX-License-Identifier: GPL-3.0-only
/**
 * The terminal output that draws a pane again from a tmux capture: its
 * screens, cursor, cursor visibility and mouse mode (change
 * restore-alternate-screen).
 */
import type { TmuxPaneCapture, TmuxPaneModes } from './tmux/controlClient'

/** SGR 0: default text style (no underline, bold, colours, ...). */
export const RESET_STYLE = '\x1b[0m'
const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h'
const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l'
const CURSOR_HOME = '\x1b[H'
/** Every mouse tracking mode and encoding off. */
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l'

/**
 * Clear screen and scrollback, cursor home: the pane is drawn again from
 * scratch. The tab first goes back to its normal screen, whichever screen it
 * was on, so the redraw clears the normal screen and its scrollback. The
 * style is reset after that, because leaving the alternate screen restores
 * the style saved with the cursor, and ESC[2J paints with the current
 * background.
 */
export const CLEAR_SCREEN = LEAVE_ALTERNATE_SCREEN + RESET_STYLE + '\x1b[2J\x1b[3J\x1b[H'

/**
 * The redraw of a capture. A normal pane is its history and screen, then its
 * cursor. A pane in the alternate screen is the shell's history and screen,
 * the cursor the program's exit restores, the switch to the alternate screen,
 * then the program's screen and cursor. Both end with the pane's modes.
 *
 * The text style is reset on both sides of each captured text. capture-pane
 * -e assumes it starts from the default style, so a style left on by earlier
 * output would colour its plain cells. It also never ends with a reset, so a
 * capture whose last cell is styled would leave that style on for the
 * program's next redraw. tmux can't report the program's current style;
 * between screen updates it is the default. The reset before ESC[?1049h also
 * makes the default style the one the program's exit restores.
 */
export function renderCapture (capture: TmuxPaneCapture): string {
    let out = RESET_STYLE + toCrlf(capture.text) + RESET_STYLE
    const alternate = capture.alternate
    if (alternate) {
        if (alternate.savedCursor) {
            out += moveCursor(alternate.savedCursor.x, alternate.savedCursor.y)
        }
        // ESC[?1049h clears the alternate screen but leaves the cursor where
        // it was: draw the program's screen from the top.
        out += ENTER_ALTERNATE_SCREEN + CURSOR_HOME + RESET_STYLE + toCrlf(alternate.text) + RESET_STYLE
    }
    return out + moveCursor(capture.cursorX, capture.cursorY) + renderModes(capture.modes)
}

/** Cursor visibility, then every mouse mode off and the pane's mode and encoding on. */
export function renderModes (modes: TmuxPaneModes): string {
    let out = (modes.cursorVisible ? '\x1b[?25h' : '\x1b[?25l') + MOUSE_OFF
    if (modes.mouseMode) {
        out += `\x1b[?${modes.mouseMode}h`
    }
    if (modes.mouseEncoding) {
        out += `\x1b[?${modes.mouseEncoding}h`
    }
    return out
}

function toCrlf (text: string): string {
    return text.replace(/\n/g, '\r\n')
}

function moveCursor (x: number, y: number): string {
    return `\x1b[${y + 1};${x + 1}H`
}
