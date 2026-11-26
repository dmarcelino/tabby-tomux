# Design

## Context

See proposal.md, "Why", for the bug.

`TomuxPaneSession.captureSnapshot` (`src/paneSession.ts`) runs `capture-pane -p -e -J -S -` and `display-message` for the cursor as one tmux command line. It returns the captured text with `\n` turned into `\r\n`, followed by a cursor move (`ESC [ row ; col H`). `OutputGate.open` writes that string, then the output held since the capture started, then live output. Three callers use `captureSnapshot`: `start({ adopt })`, `start({ adopt, redraw })` (which puts the clear-screen sequence in front) and `switchPane`.

What was checked while finding the cause (in the `/diagnose` run):
- tmux 3.8 (the macOS machine's tmux, from `tmux -V`; the Debian test host runs 3.5a), on a throwaway server: `printf 'next \e[4mlast\e[0m'` captures as `next ESC[4mlast`. The program's own reset is missing. Writing two plain spaces after `last` makes tmux emit `ESC[0m`.
- A live Claude Code pane captured with the same command ends in `ESC[4m ESC[38;2;255;193;7m … #42 ESC]8;; ESC\`. The link is closed, but underline and colour are still on.
- Feeding that snapshot into `@xterm/headless` 5.5, followed by a redraw that only sets and restores the colour, gave underlined text. The same test with a capture that ends in `ESC[0m` gave plain text.

tmux has no format for a pane's current text style, so tomux can't know what style the program has switched on.

## Goals / Non-Goals

**Goals:**
- After any snapshot, the terminal's text style is the default before newer pane output is written.
- One change point that covers all three callers.

**Non-Goals:**
- Restoring other terminal state the capture leaves out: the alternate screen, mouse tracking, bracketed paste, cursor-key mode, the scroll region, the cursor's shape and whether it is visible. These are separate gaps with different costs, and the reported bug doesn't depend on them.
- Changing what tmux captures, or the `capture-pane` flags.

## Decisions

### 1. Write `ESC [ 0 m` after the captured text, before the cursor move

`captureSnapshot` returns `text + '\x1b[0m' + cursorMove`. SGR 0 resets every style (underline, bold, dim, italic, reverse, strikethrough, colours, underline colour). OSC 8 hyperlinks are not touched, but tmux already closes any open link at the end of each captured line.

Alternatives considered:
- **Restore the program's real style.** Not possible: tmux reports no format for the current style. Working it out from the last captured cell is exactly the wrong guess that causes this bug.
- **Reset in `OutputGate.open` or in the tab component.** Either would also work, but the reset belongs to the snapshot's contents. Doing it in `captureSnapshot` keeps `OutputGate` generic and covers `switchPane` without touching it.
- **Add the reset only when the capture doesn't already end with one.** This needs parsing for no benefit: a second SGR 0 does nothing.

Why the default style is the right assumption: full-screen programs such as Claude Code, vim and less, and shell prompts, finish each screen update with the style back to default. Between updates, which is when a capture usually happens, the program's style is the default. A capture taken in the middle of an update is covered under Risks.

### 1b. Also reset at the start: before the clear, and before the captured text

Found in code review. `capture-pane -e` assumes the terminal starts in the default style: its first unstyled cells carry no SGR code. On a fresh terminal (adopting at startup) that holds. When a tab redraws after reconnecting (`start({ adopt, redraw })`) or follows a new active pane (`switchPane`), the terminal has already shown output, and that output may have stopped partway through an update, with a style still on. `ESC[2J` then fills with the current background, because xterm.js erases with the current background colour (BCE), and the capture's first plain cells inherit the style.

So `CLEAR_SCREEN` becomes `ESC[0m ESC[2J ESC[3J ESC[H`, and `captureSnapshot` returns `ESC[0m` + text + `ESC[0m` + cursor move. The leading reset in the snapshot covers a capture written without a clear. That case is the startup adopt, where it does nothing, but it keeps the snapshot self-contained. The pane-switch marker (an OSC title sequence) is not affected by SGR, so it stays first.

Alternative considered: reset only in `CLEAR_SCREEN`. That would cover both callers that clear today, but a later caller that writes a snapshot without a clear would bring the bug back. A second reset costs four bytes.

### 2. The test checks the emitted string

The new test in `src/paneSession.spec.ts` uses `FakeTmux` overrides. The capture's last line ends in `ESC[4mlast` and the cursor reply is `2 1 80 24`. The test asserts that the emitted text contains `ESC[4mlast ESC[0m ESC[2;3H`, with the reset after the text and before the cursor move. It checks both `start({ adopt: true })` and `switchPane`. The override key must be the real command, `display-message -p -t %0 "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"`. The existing tests' `CURSOR` key had only two fields, so it never matched that command, and those tests never checked the cursor move. They now use the real command and assert the cursor move as well. The start-of-snapshot reset gets its own tests: `switchPane` output must begin, after the marker, with `ESC[0m ESC[2J`, and `start({ adopt, redraw })` output must begin with it too. The captured text in both must follow an `ESC[0m`.

The repo has no terminal emulator in its dev dependencies. An xterm-level test would add `@xterm/headless` only for this one test, so the string assertion is used instead. The headless-xterm check from the diagnosis is recorded under Context.

## Risks / Trade-offs

- [The capture happens in the middle of the program's update, after it switched a style on and before it wrote the text] → The rest of that update, replayed from held output, draws without the style. That is one update's worth of cells, and the program's next full redraw fixes it. Before this change the same race caused the opposite fault, an extra style, and that one lasted until a clear.
- [Programs that rely on a style lasting across updates, such as a shell set to keep a colour on after its prompt] → Rare. Text typed after a restore would lose that colour until the program sets it again. Accepted.

## Migration Plan

None. Rolling back means reverting the one-line change.
