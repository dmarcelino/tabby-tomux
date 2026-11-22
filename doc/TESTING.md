# Testing notes

## Reliability pass (task 10.1), 2026-11-22

Setup: Tabby 1.0.238 on macOS. The test host runs Debian 13 with tmux 3.5a and is reached through an SSH port forward (see README, "Test host"). Tabby was driven through its DevTools port, and each result was checked on the host with `tmux list-windows` / `tmux list-clients`.

| Check | Result |
|---|---|
| **Heavy output:** `yes \| head -c 50M` in one tab | Finished in 28 s (about 1.8 MB/s through the port forward). Both that tab and another tab responded normally afterwards. No flow control (`pause-after`) was needed at this rate. |
| **Network drop:** port forward killed with 8 tabs open | All 8 tabs said "Lost the connection to tmux". The host kept all 8 windows, with 0 clients attached. After the forward was restored, Reconnect brought each tab back to its own window with its scrollback, with 1 client, 8 windows and no extra tabs. |
| **11 windows restored:** quit and relaunch | 11 tabs, all bound to 11 distinct windows. The window count stayed at 11, and each session had one client. Showing all 11 tabs took about 14 s. |
| **Eight tabs restored** (task 9.3) | 8 tabs, 8 windows before and after, **one** shared SSH connection. The password-prompt part needs a password-protected profile and was not tested. |
| **Two Tabby windows on one session** | The second window shows every window of the session (a known limitation), so the host had 2 clients. Closing the second window killed nothing: 11 windows remained, and the main window's 11 tabs stayed live. |
| **Laptop sleep and resume** | **Not tested**: it can't be simulated in this setup. The network-drop test is the closest. |

## Behaviour checks done against the test host

These cover tasks 7.x, 8.x and 9.x in `openspec/changes/add-tomux-plugin/tasks.md`:
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

## Not yet verified

- A password or keyboard-interactive login completing inside a tomux tab (tasks 3.1 and 9.3). The test host uses key login, and keyboard-interactive login is disabled on it.
- Windows, the main target platform. Everything above ran on macOS.

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
