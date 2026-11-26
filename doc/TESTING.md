# Testing notes

## Reliability pass (task 10.1), 2026-11-22

Setup: Tabby 1.0.238 on macOS. The test host runs Debian 13 with tmux 3.5a and is reached through an SSH port forward (see README, "Test host"). Tabby was driven through its DevTools port, and each result was checked on the host with `tmux list-windows` / `tmux list-clients`.

| Check | Result |
|---|---|
| **Heavy output:** `yes \| head -c 50M` in one tab | Finished in 28 s (about 1.8 MB/s through the port forward). Both that tab and another tab responded normally afterwards. No flow control (`pause-after`) was needed at this rate. |
| **Network drop:** port forward killed with 8 tabs open | All 8 tabs said "Lost the connection to tmux". The host kept all 8 windows, with 0 clients attached. After the forward was restored, Reconnect brought each tab back to its own window with its scrollback, with 1 client, 8 windows and no extra tabs. |
| **11 windows restored:** quit and relaunch | 11 tabs, all bound to 11 distinct windows. The window count stayed at 11, and each session had one client. Showing all 11 tabs took about 14 s. |
| **Eight tabs restored** (task 9.3) | 8 tabs, 8 windows before and after, **one** shared SSH connection. The password-prompt part was checked on Windows on 2026-11-23 (see below). |
| **Two Tabby windows on one session** | The second window shows every window of the session (a known limitation), so the host had 2 clients. Closing the second window killed nothing: 11 windows remained, and the main window's 11 tabs stayed live. |
| **Laptop sleep and resume** | Not tested in this setup. It was checked on Windows on 2026-11-23 (see below). |

## Behaviour checks done against the test host

These cover tasks 7.x, 8.x and 9.x in `openspec/changes/archive/2026-11-23-add-tomux-plugin/tasks.md`:
- **Typing:** `echo "a b  c é"` arrived with the double space and the `é`. The up arrow recalled history. A 118 KB paste with UTF-8, quotes and `$` arrived byte for byte, with a matching md5.
- **Opening the profile:**
  - A new session gets exactly one window, bound to the tab.
  - An existing session's lowest window binds, and the others open as extra tabs.
  - `+` and the new-tab hotkey with a tomux default profile each create one window and one tab.
  - A window created from another client opens one tab.
- **Closing:**
  - A user close kills only that window.
  - Quitting Tabby keeps every window.
  - Restart keeps the window. Duplicate creates a new one. Reopen-closed creates a new one.
- **Restore:**
  - Order is kept, and each window's history is shown once.
  - Tabs not yet shown keep their window reserved.
  - A window killed while Tabby was closed does not come back, and a window created meanwhile opens as an extra tab.
- **Resize and focus:**
  - tmux's window size matched the tab after each window resize (132×39, 90×25, 120×35).
  - tmux's current window follows the focused tab.
- **Renames:** tmux to tab, tab to tmux (Tabby's custom title is cleared afterwards), and two quick renames ending on the second.
- **Shared SSH connection:** closing a plain SSH tab that shared the connection left tomux connected.

## Windows checks (tasks 3.1, 9.3 and 10.1), 2026-11-23

Setup: Tabby 1.0.238 on Windows (ARM64), plugin copied into `%APPDATA%\tabby\plugins\node_modules`. The user ran these checks by hand and reported that both passed. Tabby's `log.txt` shows the restores.

| Check | Expected result (passed) |
|---|---|
| **Password login inside a tomux tab** (task 3.1): a tomux profile on an SSH profile with authentication method "Password" and no saved password | Tabby's password prompt appears inside the tomux tab. After the password, the tmux window shows a shell and typed commands run. |
| **Eight tabs of a password profile restored** (task 9.3): 8 windows in a separate session, quit and relaunch | One password prompt for all 8 tabs. The session still has 8 windows and one client. |
| **Laptop sleep and resume** (task 10.1): Windows put to sleep for a few minutes with tomux tabs open | The tabs either stay live or offer a reconnect. A key press brings each one back to its own window, with the same window count, one client and no extra tabs. |

Everyday use on Windows over several days also covered restoring tabs after a restart (logged with sizes, captures and screen state since PR #2), opening new windows and typing.

## Not yet verified

- The heavy-output, network-drop, 11-window and two-Tabby-window checks of the 2026-11-22 reliability pass were run on macOS only.

## Tabby version check (task 10.2), 2026-11-22

The newest Tabby build on GitHub releases is v1.0.238 (2026-10-07). Tabby publishes no separate nightly release, and the newest npm typings are older (1.0.231-nightly.0). Everything above ran on 1.0.238. The plugin loads, and the behaviour spikes 2 and 3 checked (the SSH-tab subclass login, close detection on user close, quit and window close) passed with the final code. Re-run this file's checks when a newer Tabby ships.

## Code-review fixes (18 findings), 2026-11-22

Unit tests were added for each fix (275 tests in total). Then these end-to-end checks ran in Tabby 1.0.238 against the test host:

| Item | Check | Result |
|---|---|---|
| 1 | A failed command inside a `;` line | Confirmed against real tmux 3.8 that tmux skips the rest of the line. The gateway now settles the skipped commands at once (unit tests). |
| 2 | Close a tab while it is still connecting | Its connection reference was released (count back to 1). No window was left claimed. |
| 3 | `+` on a connected session | The new window's first prompt shows without typing. |
| 4 | Open a tab during a 400 KB paste | The same connection was reused, and the paste arrived intact (md5 match) with 1 client. |
| 5 | Shift+F3 and Ctrl+F3 into `cat -v` | Shows `^[[1;2R^[[1;5R`. |
| 6 | Raw mode `printf 'ABC\nDEF'` | `DEF` is printed under column 3, not at column 0. |
| 8 | Window renamed to `build\|test` | The title is correct and other tabs keep working. |
| 10 | Network drop, then reconnect ONE tab and wait 9 s | No extra tabs. After all reconnect: 12 tabs on 12 distinct windows, 1 client. |
| 11 | Network drop | The tab shows "Press any key to reconnect", and a key press reconnects it to the same window. |
| 12 | `detach-on-destroy off`, last window of a session killed | tmux moved tomux's client to another session. tomux dropped that client and closed the session's tabs. The other session was untouched. |
| 13 | Re-adopt a window printing every 10 ms | 1,084 lines on screen, with no duplicates or gaps across the snapshot boundary. |
| 14 | `+` after a split pane was closed with close-pane, leaving its window unclaimed | A new window was created and the leftover was not taken. |
| 16 | Rename a split with the right pane focused | Only the right pane's window was renamed. |

Items 7 (SSH channel cleanup), 9 (no hang after the connection ends), 15 (title echo), 17 (reopen is not closed) and 18 (failed claim) are covered by unit tests only.

tomux now logs every tmux window it kills, with the reason, in Tabby's `log.txt`. Two windows of the test session disappeared at an unknown point between earlier runs. Repeating the suspect sequence (restore, a second Tabby window, closing it, quitting) killed nothing. The likeliest cause is tabs closed by hand while Tabby was open on screen, which kills by design.

## Program titles (change show-app-titles, task 5.2), 2026-11-22

Setup as in the reliability pass: Tabby 1.0.238 on macOS, test host with tmux 3.5a, Tabby driven through its DevTools port with `TOMUX_DEV=1`. Claude Code is not installed on the test host, so program titles were set with `printf '\033]0;<title>\007'`, the sequence Claude Code and shell prompts use. The host's bash prompt sets no title inside tmux.

| Check | Result |
|---|---|
| Program title on an unnamed window | The tab and its split container showed `fix login bug`. The tmux window name stayed `tmux:15`. An empty title returned the tab to `tmux:15`. |
| A name given in tmux | `rename-window api2` showed `api2`, and a later program title did not replace it. Renaming back to `tmux:15` in tmux showed the latest program title again. |
| Tabby rename to the shown program title | Renamed the tmux window to `fix login bug`, cleared Tabby's custom title, and later program titles no longer changed the tab. **Failed at first**: `titleChange$` drops a custom title equal to the title shown. Fixed by also listening to `recoveryStateChangedHint$`, then passed. |
| Tabby rename to `tmux:15` | The tab followed the program title again. |
| Reconnect | The tab came back to the same window with the same title. |
| Restart | A restored tab not yet shown, whose pane title had been changed in tmux while it was not attached, showed that title when first shown. |
| Pane switch inside tmux | `split-window`: the untitled new pane showed `tmux:15`. A title set there showed. `select-pane` between the panes switched between the two titles, and `kill-pane` went back to the remaining pane's title. |
| "Disable dynamic tab title" on the tomux profile | A tab from the profile and a tab for a window created with `new-window` in tmux both ignored program titles. Turning the toggle off again made the open tab show titles without a reconnect. |
| Tabby split with two tomux panes | Each pane showed its own program title. The container showed both, focused pane first: `right job \| left job`. |

Found while testing, not caused by this change: a restored tab that is never shown during a Tabby session saves a recovery token without its window, because `getRecoveryToken` reads `windowId`, which is set only on binding. After a second restart such tabs have no window, so tomux treats their windows as unclaimed and opens duplicate tabs for them, while the old tabs would create new windows when shown. Restarting twice in this session left 14 such tabs, which were closed by hand. No tmux window was lost.

### Code-review fixes (task 6.6), 2026-11-22

Same setup, with the review fixes loaded.

| Check | Result |
|---|---|
| Pane switch while the old pane keeps printing titles (a loop setting `busy <n>` every 50 ms) | 10 switches each way: every switch to the untitled pane showed `tmux:12`, and every switch back showed `busy …`. The pane-switch marker never appeared as a title. |
| Split of a tomux pane and a local shell, renamed `work` with the local shell focused, then the tomux pane focused and "Split right" | The split kept `work`, and the tmux window stayed `tmux:15`. The new pane's window stayed `tmux:16`. |
| Split of two tomux panes showing `left job \| right job`, rename confirmed unedited | No window was renamed (`tmux:17`, `tmux:18`). The custom title was cleared, so the split still showed the joined titles. |
| Lone tab, rename confirmed on the shown program title | Still pins it: the window was renamed `pin me`. |

The repeated restarts of another test run in the meantime had left 28 tabs without a window (issue #1). They were closed, and every remaining tab was shown once so its window is saved on the next quit. One window of the test session was removed outside tomux during that run.

### Windows, macOS host with Claude Code, 2026-11-23

Setup: Tabby 1.0.238 on Windows (ARM64), plugin copied into `%APPDATA%\tabby\plugins\node_modules`. The test host runs macOS with tmux 3.8, bash 5 and Claude Code 2.1.330. Tmux titles were read with `display -p '#{host}|#{pane_title}'`, and the bytes Claude Code writes were recorded with `pipe-pane` in a separate tmux server.

| Check | Result |
|---|---|
| Restore after a restart | Three tabs restored to their windows. Panes created before the host was renamed showed the old host name: their `#{pane_title}` is the old name and `#{host}` the new one (the known limitation in design.md). |
| New pane | `#{pane_title}` equals `#{host}`, so the tab shows `tmux:<n>`. |
| Claude Code start and exit | Claude Code sets `OSC 0 "✳ Claude Code"` when it starts and an empty `OSC 0` when it exits; it uses no title stack. A title set before it (`foo`) is not restored: tmux's pane title is empty afterwards and the tab shows `tmux:<n>`, as the spec says. |
| Shell prompt that sets the folder as title (bash `PS1` with `\e]2;\W\a` when `$TERM` is `tmux*`) | Every tab showed its current folder. After Claude Code exited, the next prompt set the folder again. The panes with the old host name changed to their folder after their shell was restarted. |
| Claude Code's working indicator | Inside tmux Claude Code only ever sets `✳ <topic>`, so the tab cannot show when it is working. With `TMUX` unset it alternates `◐`/`◑` while working and sets `✳` when done, whatever `TERM` is. With `TMUX` set and `TERM=xterm-256color` it again sends only `✳`. Claude Code decides this from `$TMUX`, not tomux. |
| Claude Code started with `TMUX` unset in tomux tabs (a shell alias `env -u TMUX -u TMUX_PANE claude` inside tmux) | The tab showed `◐`/`◑` while Claude Code worked and `✳` when it was done. |

## SSH toolbar, SFTP and ports (change add-ssh-toolbar), 2026-11-22

Tabby 1.0.238 on macOS, test host Debian 13 with tmux 3.5a reached through a local port forward. Tabby was driven through its DevTools port, with the plugin linked to the change's branch. Results were checked in the DOM and on the host with `tmux list-windows` / `tmux list-clients`.

| Check | Result |
|---|---|
| Toolbar, connected | A green dot, `user@host:port` followed by the session name, then Reconnect, SFTP, Ports and Unpin. No working-directory tip. |
| Toolbar, connection lost | A red dot, and only Reconnect and Unpin. |
| Unpin / pin | Unpin hides the toolbar and shows Tabby's pin button. Pinning shows it again. |
| SFTP from the toolbar, after `cd /var/log` | The panel opens in `/var/log`, with no new login. |
| SFTP from the tab menu ("Open SFTP panel") and the `open-sftp` hotkey | Both open the panel, in `/var/log`. |
| Closing the panel | A click inside it keeps it open. A click on the terminal, its close button, and a lost connection each close it. It is removed from the page within about 150 ms. |
| tmux window during SFTP use | `capture-pane` before and after was identical: nothing was typed into the pane. |
| "Copy current path" in the tab menu | Present, and it copied `/var/log`. |
| Ports dialog | Opens for the tab's SSH session. A local forward 127.0.0.1:18080 → localhost:22 answered with the host's SSH banner. A second tomux tab of the session listed it, and removing it there closed the port. |
| Reconnect while connected | Same window and the same tmux connection. History is shown once. Another tab kept receiving output, and no windows were added or removed. |
| Reconnect after the connection was lost | Logs in again, on a new connection, and shows the same window. No windows were added or removed. |
| Reconnect after the window was killed while disconnected | The tab closes ("no longer exists"), and no window is created. |

Two bugs were found and fixed in this run. The panel stayed on the page when Tabby's window was in the background (its removal waited on an animation that Chromium hardly runs then). It also stayed after a lost connection (the removal ran outside Angular's zone).

Not tested:
- Uploading and downloading a file in the SFTP panel. Both use native file dialogs, which DevTools can't operate.
- Forwarded ports set in the SSH profile. The test profile has none, and Tabby's own SSH session applies them unchanged.

A code review afterwards found 12 more issues, fixed with unit tests (318 tests in total) but **not yet re-checked in a running Tabby**:
- the SFTP file list didn't scroll;
- Reconnect could close the tab (after `exit`, or with the profile set to close on session end);
- a double-click on Reconnect connected twice and left tmux's client attached;
- Reconnect appended the history again unless the profile clears service messages;
- the toolbar could show a lost tab as connected;
- smaller items listed in the change's design (T2–T4, T6).

The remaining checks are in tasks 3.4 and 4.2 of the change.

### Windows, after the code-review fixes (tasks 3.4 and 4.2), 2026-11-23

Setup: Tabby 1.0.238 on Windows (ARM64), plugin built from the change's branch (375 unit tests) and copied into `%APPDATA%\tabby\plugins\node_modules`. Tabby's `log.txt` shows `tomux plugin loaded`. The user ran these checks by hand and reported that all of them passed.

| Check | Expected result (passed) |
|---|---|
| Toolbar, connected | Connection dot, `user@host:port` and the session name, Reconnect, SFTP and Ports. |
| SFTP from the toolbar, the tab menu ("Open SFTP panel") and the `open-sftp` hotkey, after a `cd` | The panel opens in the shell's folder, with no new login. |
| Closing the panel | Its close button and a click on the terminal close it. |
| File list in a long folder such as `/usr/bin` | The list scrolls. |
| Upload and download one file | Both work through Windows' native file dialogs. |
| tmux window during SFTP use | Nothing is typed into the window. |
| "Copy current path" in the tab menu | Present, and copies the shell's folder. |
| Reconnect after `exit` in a nested shell, and with the profile set to close on session end | The tab stays open and shows its window again. |

Still not checked after the code-review fixes (task 4.2):
- A double-click on Reconnect leaves one tmux client attached, and closing every tab detaches it.
- With "clear service messages on connect" off, the history appears once after Reconnect.
- After a dropped connection, the pinned toolbar turns red without other input.
- Forwarded ports set in the SSH profile are active and listed in the Ports dialog.
- Ports and the basic Reconnect cases were not repeated on Windows. The macOS run above covers them on the code before the review fixes.

Found while testing, not part of this change (issue #1): a restored tab that is never shown saves a recovery token without its window id. After a second restart it no longer reserves its window, so tomux opens an extra tab for that window, and showing the restored tab later creates a new window.

## Home and End in application cursor mode (change fix-app-cursor-home-end, task 3.2), 2026-11-25

The user tested the fix by hand in a running Tabby and reported that the Home and End keys work. The report did not name the Tabby version, the host or the programs used, and did not mention the arrow keys, so the arrow scenario in the change's spec is covered by unit tests only.

## `+` follows the active tab (change plus-follows-active-tab, tasks 3.1–3.3), 2026-11-25

Setup: Tabby 1.0.238 on macOS (arm64), plugin built from the change's branch (389 unit tests), started with `TOMUX_DEV=1`. The test host runs Debian 13 with tmux 3.5a, reached through the SSH port forward. Default profile: the tomux profile for session `tomux-e2e`, given a red tab colour for these checks. A second tomux profile, with no colour, uses session `tomux-fresh` on the same host. Tabby was driven through its DevTools port. `+` was the real tab-bar button, and the new-tab hotkey was a real `⌘-T` key event. Choosing a profile "from the selector" called `ProfilesService.openNewTabForProfile` inside Angular's zone, as the selector's own callback does. The selector UI itself was not clicked. Every result was checked on the host with `tmux list-windows -a` and `tmux list-clients`.

| Check | Result |
|---|---|
| Profile tomux receives on `+` (3.1) | `id` is the default profile's id (`tomux:e2e`). |
| `+` on a non-tomux tab, default session connected | New window in the default session, tab not followed. |
| `+` on a tab of the default session | New window in that session. |
| Choosing the other profile while a default-session tab is active | Opens the other profile's session, not the active tab's. |
| `+` on a `tomux-fresh` tab | New window in `tomux-fresh`, one client. The tab shows `tomux-fresh` (not the default's name) until tmux names the window, and has no colour bar (3.3). |
| Choosing the default profile while a `tomux-fresh` tab is active | New window in `tomux-fresh`, as with `+`. |
| `⌘-T` with the focused pane of a two-pane split on `tomux-fresh` | New window in `tomux-fresh`. Every Tabby tab is a split container, so this path runs on every `+`. |
| Session name changed to `tomux-fresh2` in the profile, `+` on an older `tomux-fresh` tab | New window in `tomux-fresh`. No `tomux-fresh2` session was created. |
| `+` on a tab whose SSH profile is missing | Falls back to the default session, with the default's colour. |
| `+` on a disconnected `tomux-fresh` tab (tmux client killed with `kill -9`) | New tab in `tomux-fresh` bound to a newly created window. The disconnected tabs' windows were not taken and got no extra tabs. |
| Second Tabby window showing only `tomux-fresh`, `+` with a `tomux-fresh` tab active (the reported problem) | Exactly one new tab in that window, for a new `tomux-fresh` window. No tab opened for `tomux-e2e`'s windows, and `tomux-e2e` kept its single client. |
| Same window, `+` with its Welcome tab active | Tabs opened for all three `tomux-e2e` windows (first open in that window; out of scope, stated in the README). |
| **New terminal** from the menu of an inactive `tomux-e2e` tab while a `tomux-fresh` tab is active | New window in `tomux-fresh`: it follows the active tab, not the tab whose menu was used (stated in the README). |

Found and fixed during this run: a followed tab got colour `''` instead of none, because a profile's config proxy reads an unset colour as `''`. It now treats any empty value as none, as Tabby does.

Seen but outside this change: detaching a session's control client from the host (`tmux detach-client`) closes all of that session's tabs, because tmux sends `%exit`. The windows keep running. The test used `kill -9` on the client instead, to get a lost connection.

Not run: clicking the profile selector UI itself, and checks on Windows or Linux.

### Code-review fixes (task 5.4), 2026-11-25

Same setup (Tabby 1.0.238 on macOS, Debian 13 test host with tmux 3.5a, driven through DevTools). Two extra tomux profiles were added for this run and removed afterwards.

| Check | Result |
|---|---|
| A tab of a tomux profile that was deleted after the tab opened, `+` | Falls back to the default session. |
| A tab whose session name is `a.b` (shows "tmux does not allow "." in session names."), `+` | Falls back to the default session. |
| Tabby's **Switch profile** to the default profile on the only tab of `tomux-fresh` (Tabby's own `switchTabProfile`, with the profile picker stubbed to return the default) | Before the fix: the replacement followed the replaced tab into `tomux-fresh` on a new window. After the fix (design D6): the replacement opens on a new window in the default session. The replaced tab's window keeps running: Tabby destroys the old tab without a user close, so tomux does not kill its window. |
| Switch profile to the default on the focused pane of a two-pane `tomux-fresh` split | That pane becomes a tab on the default session. The other pane is unchanged. |
| After the fix: `+`, `⌘-T`, and `+` from a pane of a two-pane split, each on a `tomux-fresh` tab | Each still follows: one new window in `tomux-fresh`. |

## Text style after a restored screen (change reset-style-after-snapshot, task 3.2), 2026-11-26

Setup: Tabby 1.0.238 on macOS, test host Debian 13 with tmux 3.5a reached through a local port forward. Tabby was started with `TOMUX_DEV=1` and driven through its DevTools port. The restored tab's xterm.js buffer was read cell by cell. The first run used the unfixed build (`main` at 00c599d), the second the change's branch. `log.txt` showed `tomux plugin loaded` both times.

In window `@2` of session `tomux-e2e`, a script drew `status ESC[4mlast ESC[0m` on the bottom row, with nothing written after it, so tmux's capture of the pane ends with underline on. It then redrew row 3 every second as `ESC[33m redrawn NNNNN ESC[39m`, which sets only the colour. With the tab open, Tabby was quit and started again, and the restored tab was shown.

| Check | Unfixed build | Fixed build |
|---|---|---|
| Cells of the live-redrawn `redrawn NNNNN` line that are underlined | 12 of 12 (counter at 00030 and 00052) | 0 of 12 (counter at 00082 and 00090: it was still redrawing) |
| Colour of that line | yellow | yellow |
| `last` on the bottom row (underlined by the program) | underlined | underlined |
| Bash prompt in window `@7`, redrawn after the resize on restore (the script there had been stopped) | underlined (screenshot) | 0 of 12 cells underlined |

Not checked in this run: restoring a tab that runs Claude Code. The test host has no Claude Code, and the only Claude Code on the test machine runs in tmux sessions in daily use, which a tomux tab would resize.

Afterwards, 2026-11-26: the user tested the branch of PR #11 by hand in Tabby and reported that it worked. The report did not name the Tabby version or the programs in the restored tabs.

## Graphics query as a pane title (change ignore-kitty-graphics-pane-title, task 3.2), 2026-11-26

Before the fix, a throwaway local tmux 3.8 server showed the cause: after a program set the title `fix login bug` with OSC 2 and then wrote the Kitty graphics query `ESC _ Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC \`, `display-message -p '#{host}|#{pane_title}'` returned the query as the pane title.

Afterwards, 2026-11-26: the user tested the branch of PR #12 by hand in Tabby and reported that it worked. The report did not name the Tabby version, the tmux version, or whether the bug was first reproduced on the unfixed build.

## Tab order kept in tmux (change restore-tab-order, tasks 5.1–5.3), 2026-11-26

2026-11-26: the user tested the branch of PR #14 by hand in Tabby and reported that it worked. The report did not name the Tabby or tmux version, or which of the checks in tasks 5.1 and 5.2 were run (the `@tomux-order` values after a drag and after a hotkey move, a restart with tab restore off, a window created while Tabby was closed, and a restart with restore on).

Not checked: task 5.3, whether `set-option -w … @tomux-order` and `#{@tomux-order}` work on a tmux older than 3.6 (the only version checked, locally, while writing the change). So the README states no minimum tmux version for this feature.

## Alternate screen after a redraw (change restore-alternate-screen, task 4.3), 2026-11-26

Before the change, the user reproduced the bug by hand in Tabby: Claude Code started and exited normally came out clean, and so did Reconnect while it ran, but exiting it after a Tabby restart left its screen behind, with the shell's output printed over it from the top-left corner.

Setup: Tabby 1.0.238 on macOS, started with `TOMUX_DEV=1` and driven through its DevTools port, plugin linked to the change's branch (455 unit tests). The SSH host was the same Mac (`127.0.0.1:22`), with tmux 3.8 and a throwaway session `tomux-alt`; the usual Debian test host was not reachable. Each check read the tab's xterm.js state (active buffer, cursor, cursor visibility, mouse tracking mode, every buffer line) and compared the visible screen line by line with `tmux capture-pane -p` of the pane. Full-screen programs: Claude Code 2.1.332 (alternate screen, mouse tracking on, cursor shown), and a small script that enters the alternate screen, hides the cursor and turns on mouse modes 1002 and 1006, and turns all of that off again on exit. Programs were exited with `tmux send-keys`.

| Check | Result |
|---|---|
| Claude Code running, Tabby quit and started again | Tab restored on the alternate screen, screen as tmux's, cursor where tmux has it, mouse tracking `any`. Log: `Captured pane …, alternate screen` |
| Then Claude Code exited | Normal screen, identical to tmux's: the history (`old line 1`…`50`, each once) and the prompt on the row tmux restored. No Claude Code text anywhere in the buffer. Cursor shown, mouse off |
| Script running (cursor hidden, mouse 1002/1006), Tabby restarted | Alternate screen, cursor hidden, mouse `drag`, screen as tmux's |
| Then the script exited | Normal screen as tmux's, cursor shown, mouse off |
| Reconnect while the script ran, then the script exited | Alternate screen with cursor hidden and mouse `drag` after Reconnect; after the exit, normal screen as tmux's with no script text in the buffer |
| Connection dropped (tmux control client killed with SIGKILL, so no `%exit`), script exited, then Reconnect | Normal screen as tmux's, history once, no script text, cursor shown, mouse off |
| Same with SIGTERM | tmux sends `%exit`, which tomux treats as the session ending: the tab closes (existing behaviour, not part of this change) |
| Second pane in the window, active pane changed script → shell → script, then B→A→B in one tmux command | Each redraw on the right screen with the right cursor visibility and mouse mode; the quick switch ended on the shell pane. Screen as tmux's each time |
| Plain shell pane, Tabby restarted | Normal screen as tmux's, cursor shown, mouse off |
| Claude Code running, Tabby quit, its window made smaller (120x33 → 97x25), started again | tmux resized to 97x25 before the capture; screen as tmux's on the alternate screen; after Claude Code exited, normal screen as tmux's with no Claude Code text |

Found and fixed during this run: switching back to the script's pane drew its screen from the row of the shell's saved cursor instead of the top, because `ESC[?1049h` clears the alternate screen without moving the cursor. Claude Code's restore had looked right only because the shell's cursor was on the last row and Claude Code's screen fills every row. The redraw now moves the cursor home after the switch (unit test in `src/paneRedraw.spec.ts`), and the pane-switch checks above were run again on the fixed build.

Not checked: tmux older than 3.8 (the formats and `capture-pane -a` on tmux 2.1), the Debian test host, and mouse input reaching the program (only the tab's mouse mode was read, no clicks were sent).
