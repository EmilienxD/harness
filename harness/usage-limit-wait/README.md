# usage-limit-wait

A hook that **waits out your Claude subscription's usage limit** instead of letting
the turn die. When the 5-hour or weekly window is exhausted, the session pauses
until it resets — then carries on by itself.

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install usage-limit-wait
```

## Problem

On a subscription, hitting the limit ends the turn with an API error. Whatever
Claude was in the middle of stops there, and the work only resumes when you come
back hours later and re-prompt. Nothing about the situation actually needs you:
the reset time is known in advance, and the only correct action is to wait for it.

## Solution

Claude's own usage endpoint reports every window's utilization and its
`resets_at`. The hook reads it before Claude Code talks to the API, and if a
window is at or over the threshold it simply blocks — `time.sleep` — until the
window resets, re-polling along the way so an early reset (Anthropic grants
those), a cancelled subscription, or a revoked token ends the wait promptly.

It runs on two events, which between them cover every point where the next
request is about to be sent:

| Event | When |
|---|---|
| `UserPromptSubmit` | before the first request of a turn |
| `PostToolBatch` | once per tool batch, immediately before the next request |

`PostToolBatch` rather than `PostToolUse` on purpose: `PostToolUse` fires once
per tool, so parallel tool calls would spawn several hook processes all sleeping
through the same reset. `PostToolBatch` fires exactly once per model round trip.

### One hook, with an out-of-band notification

Claude Code waits for every hook on an event to finish before it renders any of
their output. Splitting notification and waiting into parallel hooks therefore
does not help: the notifier's `systemMessage` and `terminalSequence` remain
buffered for as long as the waiter is running.

Instead, one process does both jobs. When it is about to wait, it asks the host
OS to show a desktop notification and waits for that command to finish. Only
then does it enter the polling sleep. The notification is an OS side effect, so
it is already delivered even though the hook itself remains running for hours.

| Platform | Backend |
|---|---|
| Windows | Windows Runtime toast, invoked through Windows PowerShell |
| macOS | Notification Center, invoked through `osascript` |
| Linux and other Unix desktops | `notify-send`, when installed |

Every backend is best-effort and has a 10-second timeout. A missing, disabled,
or broken notification service never prevents the wait or breaks the session.

### What you actually see

Nothing at all below 90% — the common case is a hook that prints nothing.
Warnings below the blocking threshold return immediately, so Claude Code can
render them normally:

```
Claude usage: the 5-hour window is 94% used and resets at 15:59, in 1h04m.
The session will pause here by itself if it runs out.

usage-limit-wait: waited 1h04m for the 5-hour limit to reset.
```

The warning repeats at most once every 10 minutes per session
(`USAGE_LIMIT_WAIT_NOTIFY_EVERY`). When the pause is *not* going to happen —
credits opted into, no reset time reported, a reset past the cap — the terminal
notice says so instead of promising a wait that never comes.

At the start of an actual wait, the desktop notification says which limit was
reached and when Claude Code expects to resume. A second desktop notification
announces that the wait has finished. `USAGE_LIMIT_WAIT_OS_NOTIFICATION=0`
turns both off.

### It fails open, always

The hook is only meaningful for a Claude subscription, and it exits 0 —
silently, changing nothing — the moment anything says otherwise:

| Situation | How it's detected |
|---|---|
| Direct API key, or a bearer-token gateway | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` set |
| Bedrock, Vertex, or Foundry | `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` / `_USE_FOUNDRY` |
| Logged out, or a third-party CLI | no OAuth token in `~/.claude/.credentials.json` |
| Expired session, revoked access, endpoint down | the initial usage request fails, or the reading can't be parsed |
| Reset is more than `MAX_WAIT` (7 days) away | there is no live subscription behind this session |

It never blocks a tool call, never rejects a prompt, and never writes to the
model's context. Its only hook output is a `systemMessage`, shown to you and not
to Claude; desktop notifications go directly through the host OS.

After a confirmed limit has started a wait, a transient read failure does not
count as a reset. The hook keeps the last valid reading until its announced
reset time, then fails open if usage is still unreadable. This matters at the
wall, where the usage endpoint and the `claude -p /usage` fallback can fail at
the same time as ordinary model requests.

### Pay-as-you-go credits

If your account has usage credits enabled, exhausting a window doesn't stop
Claude Code, it starts charging you. That's a choice, not a default, so the hook
waits even then unless you opt in with `USAGE_LIMIT_WAIT_USE_CREDITS=1`, which
means *"don't wait, spend"*. It only takes effect when the account really does
have credits enabled and unexhausted; otherwise the normal wait happens.

### Two ways to read usage

1. `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token from
   `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR` is honoured; on macOS the
   Keychain entry is read instead when the file is absent).
2. If that yields nothing — the endpoint is undocumented and can change —
   `claude -p /usage`, whose text output carries the same two windows. That
   child process is spawned with `USAGE_LIMIT_WAIT_DISABLE=1` so it can't
   trigger this hook recursively, and it polls at most every 5 minutes because
   it costs a whole process.

If both fail, the hook exits 0 and Claude Code behaves exactly as it does
without it.

### Cost

Readings are cached in `~/.claude/.usage-limit-wait.cache.json`, shared by every
session on the machine, with a TTL that tightens as you approach the wall: 5
minutes below the warning level, 30 seconds from there to the threshold, and 15
seconds once a window is exhausted. Failures are cached too, so a machine on an
API key pays one wasted request every 5 minutes rather than one per prompt.
**Zero model calls** — the hook never talks to a model.

## Configuration

All environment variables, all optional. Set them in your shell, or in the `env`
block of `.claude/settings.json`.

| Variable | Default | Effect |
|---|---|---|
| `USAGE_LIMIT_WAIT_DISABLE` | off | Kill switch: the hook exits immediately |
| `USAGE_LIMIT_WAIT_USE_CREDITS` | off | Keep working on pay-as-you-go credits instead of waiting, when credits are available |
| `USAGE_LIMIT_WAIT_THRESHOLD` | `98` | Percent at which a window counts as exhausted. `100` waits only after the wall is hit |
| `USAGE_LIMIT_WAIT_WARN` | `90` | Percent at which the warning starts. Also where the cache starts refreshing more often |
| `USAGE_LIMIT_WAIT_NOTIFY_EVERY` | `600` | Seconds before the same warning may repeat in one session |
| `USAGE_LIMIT_WAIT_OS_NOTIFICATION` | on | Set to `0` to disable the start and completion desktop notifications |
| `USAGE_LIMIT_WAIT_MAX_WAIT` | `604800` | Longest wait, in seconds (7 days). A reset beyond this is treated as "no subscription" |
| `USAGE_LIMIT_WAIT_POLL` | `60` | Seconds between re-checks while waiting |
| `USAGE_LIMIT_WAIT_CACHE_TTL` | `300` | How long a below-threshold reading stays usable |
| `USAGE_LIMIT_WAIT_IGNORE` | — | Comma-separated window kinds never waited on, e.g. `weekly_all` to accept multi-day waits never happening |
| `USAGE_LIMIT_WAIT_FALLBACK` | on | Set to `0` to forbid the `claude -p /usage` fallback |

The default threshold of 98% starts the wait just *before* exhaustion, so no
request fails at all. The last couple of percent are discarded at the reset
anyway; use `USAGE_LIMIT_WAIT_THRESHOLD=100` if you want every drop.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers one hook on each of `UserPromptSubmit` and `PostToolBatch` |
| `.claude/hooks/usage_limit_wait_hook.py` | Reads usage, reports it, and blocks until the reset |

One script serves both events — it needs nothing event-specific — which is why
its filename has no `_<Event>_` infix like the other hooks in this repo. The
obsolete `--notify` entry from version 1.1.0 is accepted as a no-op, so replacing
the script by hand before cleaning up settings cannot create two waiters.

The `timeout` is the part you cannot omit on the waiter: `UserPromptSubmit`
hooks default to 30 seconds and other events to 600, either of which would kill
the wait long before the reset. The installed value matches
`USAGE_LIMIT_WAIT_MAX_WAIT`, and the hook's own cap fires first. The notifier
never blocks, so it keeps a small timeout of its own.

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install usage-limit-wait
```

Add `--dry` first to see the exact file list and settings diff, `--user` to
install into `~/.claude` for every project. See the [repo README](../../README.md)
for `--local` and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `hooks/usage_limit_wait_hook.py` into `.claude/hooks/`.
2. Make it executable: `chmod +x .claude/hooks/usage_limit_wait_hook.py`
3. Merge into `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py"],
            "timeout": 604800,
            "statusMessage": "Checking Claude usage limits — waits here if they are exhausted"
          }
        ]
      }
    ],
    "PostToolBatch": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py"],
            "timeout": 604800,
            "statusMessage": "Checking Claude usage limits — waits here if they are exhausted"
          }
        ]
      }
    ]
  }
}
```

`command` must resolve on the PATH of the machine running Claude Code. The
`harness` installer sidesteps this by baking in an interpreter it has verified.

</details>

Requires a working Python 3 where the installer runs. Windows and macOS need no
additional notification utility; Linux desktop notifications require
`notify-send` (usually supplied by `libnotify`). The waiting behavior itself is
pure Python standard library on every platform.

## Known limits

- The docs give no maximum for a hook `timeout`. If Claude Code clamps 604800,
  a long wait is cut short; that fails open (a cancelled hook's output is
  discarded and the session proceeds as it would without the hook).
- The usage endpoint is undocumented and unversioned, and the `/usage` text
  layout is not a contract either. Every parse is defensive: if both drift, the
  hook degrades to doing nothing, never to stalling a session wrongly.
- `statusMessage`, `systemMessage`, and `terminalSequence` are all handled by
  Claude Code, so none can announce the pause before a long-running hook exits.
  That is why the hook uses the OS directly. While the waiter sleeps you can
  still see Claude Code's spinner; <kbd>Esc</kbd> interrupts it like any other
  hook.
- Desktop notifications may be suppressed by Focus Assist / Do Not Disturb or
  by OS notification settings. On Linux, the current desktop session also needs
  a notification service and `notify-send` on `PATH`.
- Notices are per session, tracked in `~/.claude/.usage-limit-wait.notices.json`.
  Two sessions near the wall each get told once, which is the point, and a
  session that runs for days keeps only a day of history.
- With `USAGE_LIMIT_WAIT_USE_CREDITS=1` work continues at pay-as-you-go rates
  once a window is exhausted. That spends real money, which is why it is opt-in.
