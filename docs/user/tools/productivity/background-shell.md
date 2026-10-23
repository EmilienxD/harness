# Background shell

Platforms: **Pi**. Install with `harness install background-shell --platform pi`; see [installation and scope](../../getting-started.md).

`background-shell` is a Pi-only tool that extends the existing `bash` and Windows
`powershell` tools with `run_in_background`. Install it into another project from this checkout:

```powershell
uv run harness install background-shell --platform pi --root C:\Projects\YourProject
```

For all your projects, use `--scope user` instead of `--root`. Restart Pi or run `/reload`.
The installer places one extension in the selected Pi configuration; it leaves agent instructions
and settings unchanged. No npm package, tmux, WSL, or PowerShell 7 installation is required.
Bash uses Pi's configured Bash executable and command prefix. PowerShell uses Pi's native
Windows shell resolver, including Windows PowerShell when PowerShell 7 is unavailable.

Ask Pi: "Run the test suite in the background, continue the review, and inspect the result
when it finishes." The shell tool itself exposes the option and its usage guidance.
Commands start in the foreground unless `run_in_background: true` requests an immediate job
receipt. If a foreground command runs longer than the foreground limit (120 seconds by default), the same process
continues in the background without restarting. Its result includes the job ID, temporary log
path, and recent output. Completion delivers the actual exit status, elapsed time, and recent
output to the agent. Version 3.0.1 uses steering: completion reaches an ongoing task at the next
agent-loop boundary, or wakes the agent if idle. It does not interrupt an executing foreground
tool batch. When only background work remains, the agent should end its response and wait for
notification rather than run foreground sleeps or poll. The TUI shows only
``Background command `<title or command>` exited with status <status-code>.``, even when expanded;
command output remains available through `/ps` or `get_background_shell_status` with
`show_output: true`. If cancellation or a hard deadline prevents an exit code from being reported,
the status is `unknown`. Quiet commands keep running.

The agent-visible `timeout` parameter is a hard limit in seconds, measured from launch, that
terminates the command and its process tree whether it runs in the foreground or background.
It has no default. The foreground-to-background handoff is a user setting, not an agent
parameter: set `backgroundShell.foregroundTimeout` (seconds, default 120) in Pi's `settings.json`.
A command whose `timeout` is at or below that limit is cancelled in the foreground and never
moves to the background; a longer `timeout` keeps counting after handoff and cancels the job.
Cancellation before handoff stops the command; after handoff, use `cancel_background_shell` to cancel it.
Version 2.2.0 removes `execution_timeout`.
The optional Windows `powershell` tool follows your existing tool selection; installing this
package does not switch Bash commands to PowerShell syntax.

Version 3.0.0 replaces `shell_job` with two tools, both requiring the command `id`:
`get_background_shell_status` always returns status and includes recent output when its optional
`show_output` boolean is true (default false); `cancel_background_shell` stops the command and
its process tree and returns the final status. IDs are six hexadecimal characters, checked for
uniqueness within the live session. After each user message, the agent receives a small reminder
when background commands are still running, containing only their count; there is no agent listing tool.
The optional `title` parameter gives commands a short label. In Pi's terminal UI, `/ps` opens
a command selector beneath a single separator, replacing the input bar until the menu closes.
Use arrows and Enter to inspect a job, Page Up/Down or the mouse wheel over the shell to scroll,
and `x` to stop it and return to the selector. Escape returns to the list or closes the menu.
Cancelled and completed jobs stay visible until the menu closes, then disappear from the next selection.
The panel grows to fit its content up to 20 rows or 45% of the terminal height; command text
wraps across up to three rows. Press `l` to load the retained log or `f` to follow recent output.
Closing the menu restores the previous input editor and draft. Mouse scrolling requires Pi's
fullscreen mode. Completion messages show status and recent output. A final status read or
cancellation suppresses notifications still owned by the extension, but cannot retract a message
already queued in Pi. `notification_state` distinguishes `not_ready`, `pending`, `submitted`,
`delivered` (observed through Pi's finalized-message event, not proof the model acted on it),
and `consumed`. Synchronous
submission rejections are retried with capped backoff. Pi's fire-and-forget API cannot report
per-message asynchronous failures: submitted notifications without a session receipt are not
blindly resent. Status and output remain retrievable by ID.

It retains the last 8 KiB of decoded output and the first 16 MiB in a private temporary log,
with truncation reported explicitly. At most eight shell commands run concurrently (including
commands waiting in the foreground), and 64 background job receipts
are retained. Running jobs and their logs belong to the live Pi session: reload, session changes,
tree navigation, and graceful shutdown cancel them and clear the logs. They do not survive a
Pi restart. Keep Pi open to receive completion notifications.

The existing command guard still checks `bash` and `powershell` before launch, including nested
calls. A background launch result is a job receipt; hooks that infer completed filesystem work
from a shell tool's immediate result cannot use that receipt as evidence of a finished mutation.
Use native edit/write tools for work requiring those outcome-based guards or attribution.
Install one owner of each shell tool; other extensions that replace Bash or PowerShell can conflict.

## Pi implementation and verification

`background-shell` ships a Pi-only native extension in
`harness/productivity/background-shell/`. It overrides `bash` and Windows `powershell` with
an explicit `run_in_background` parameter, reuses Pi's native shell resolution and execution,
and owns bounded job receipts/logs, cancellation, and automatic completion messages.
Foreground commands automatically move to the background after a configurable limit
(`backgroundShell.foregroundTimeout` in Pi settings, default 120 seconds), preserving the running
process and output from launch. The agent-visible `timeout` is a hard deadline from launch in
either mode: at or below the foreground limit the command is cancelled without handoff, above it
the same deadline cancels the background job. Version 2.2.0 removed `execution_timeout`.
Version 3.0.1 sends completions as steering with idle wake-up, so busy tasks receive them at
the next agent-loop boundary rather than after final settlement. Executing tool batches are
not interrupted; the agent should end its response when only background work remains.
Version 3.0.0 replaces the action-based `shell_job` tool with ID-required
`get_background_shell_status` (optional `show_output`) and `cancel_background_shell`. Six-hex-character
IDs are collision-checked within the live session. User-started turns receive a hidden running-count
reminder when jobs remain; custom completion turns do not. There is no agent listing tool.
Version 2.1.0 adds optional job titles, a running count, compact completion rendering and `/ps`.
Its bounded selector/output panel replaces the editor beneath one separator, restoring the
previous editor and draft on close. Native fullscreen chat paging is disabled in memory only
while the menu is open; the panel handles Page Up/Down and normalized wheel events over its
output. Cancelled rows disappear on reopening. Final tool results consume extension-pending
notifications, not messages already queued in Pi. Submission and session delivery are distinct
`notification_state` values, with `message_end` confirming session delivery. Only synchronous
submission rejections are retried with capped backoff and on settlement; Pi's void send API
exposes no per-message asynchronous failure result. Ambiguous submissions are not blindly resent.
It has no runtime npm or shared Python dependency and installs as a native Pi npm package,
without instruction or configuration fragments. Background jobs are scoped to the live session;
reload, tree navigation, session changes, and shutdown cancel jobs and discard logs.
Command guards still evaluate the original shell call; background receipts are not completed
filesystem-outcome evidence for path guards or commit attribution. See the real RPC acceptance
journey in `tests/e2e/tools/pi-background-shell/`.
