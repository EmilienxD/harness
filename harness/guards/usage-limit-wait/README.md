# usage-limit-wait

A hook that **waits out your Claude or ChatGPT subscription's usage limit** instead
of letting the turn die. When the 5-hour or weekly window is exhausted, Claude Code
or Codex pauses until usage is restored — then carries on by itself.

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

## Problem

On a subscription, hitting the limit can end the turn with an API error. Whatever
the agent was doing stops there, and the work only resumes when you come back and
re-prompt. The reset time is already known, so the hook can wait at the request
boundary and let the agent continue automatically.

## Solution

The provider's usage service reports both windows' utilization and reset time.
The hook reads it before the next model request, and if a window is at or over the
threshold it blocks until usage returns. It re-polls throughout the wait, so an
early Anthropic reset or a ChatGPT reset ticket redeemed by the user resumes the
session promptly. After an announced time-based reset, it allows a two-minute
service-side grace period before giving up on an unreadable response.

The provider-native registrations cover the points where the next request is
about to be sent:

| Product | Events |
|---|---|
| Claude Code | `UserPromptSubmit`, then `PostToolBatch` once per tool batch |
| Codex | `UserPromptSubmit`, then `PostToolUse` after supported local tools |

Claude uses `PostToolBatch` rather than `PostToolUse` so parallel tools do not
create parallel waiters. Codex has no `PostToolBatch`; its hook uses a global
cross-process lock so concurrent `PostToolUse` processes share one actual wait.

### One hook, with an out-of-band notification

Both clients wait for a synchronous hook to finish before continuing, so one
process handles notification, polling, and completion.

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
Codex usage: the 5-hour window is 94% used and resets at 15:59, in 1h04m.
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

The hook is only meaningful for a provider subscription, and it exits 0 —
silently, changing nothing — whenever usage cannot be read safely:

| Situation | How it's detected |
|---|---|
| Claude direct API key, gateway, Bedrock, Vertex, or Foundry | Claude provider guards |
| Codex API-key login or another model provider | Codex app-server rejects the subscription usage read |
| Logged out, revoked access, missing client, or endpoint down | the initial usage request fails or cannot be parsed |
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

If your account has usage credits enabled, exhausting included usage may start
charging you. The hook waits unless you opt in with
`USAGE_LIMIT_WAIT_USE_CREDITS=1`, meaning *"don't wait, spend"*. This setting
does not redeem ChatGPT usage-restoration tickets.

### Usage readers

Claude Code uses two defensive readers:

1. `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token from
   `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR` is honoured; on macOS the
   Keychain entry is read instead when the file is absent).
2. If that yields nothing — the endpoint is undocumented and can change —
   `claude -p /usage`, whose text output carries the same two windows. That
   child process is spawned with `USAGE_LIMIT_WAIT_DISABLE=1` so it can't
   trigger this hook recursively, and it polls at most every 5 minutes because
   it costs a whole process.

Codex uses its local `codex app-server --stdio` protocol and calls
`account/rateLimits/read` with `supportsLunaReserve: false` and
`excludeResetCreditDetails: true`. Codex itself therefore owns credential-store
access, OAuth refresh, workspace selection, and the private
`/backend-api/wham/usage` request. The hook never reads `auth.json`, never handles
tokens, and never calls the ticket-consumption method.

If a reader fails, the hook exits 0 and the client behaves as it does without it.

### Cost

Readings are cached under the provider home (`~/.claude` or `~/.codex`), shared
by every session on the machine, with a TTL that tightens near the wall: 5
minutes below the warning level, 30 seconds from there to the threshold, and 15
seconds once a window is exhausted. Failures are cached too, so a machine on an
API key pays one wasted request every 5 minutes rather than one per prompt.
**Zero model calls** — the hook never talks to a model.

## Configuration

All environment variables are optional. Set them in your shell, or in the `env`
block of `.claude/settings.json` for Claude Code.

| Variable | Default | Effect |
|---|---|---|
| `USAGE_LIMIT_WAIT_DISABLE` | off | Kill switch: the hook exits immediately |
| `USAGE_LIMIT_WAIT_USE_CREDITS` | off | Keep working on pay-as-you-go credits instead of waiting, when credits are available |
| `USAGE_LIMIT_WAIT_THRESHOLD` | `98` | Percent at which a window counts as exhausted. `100` waits only after the wall is hit |
| `USAGE_LIMIT_WAIT_WARN` | `90` | Percent at which the warning starts. Also where the cache starts refreshing more often |
| `USAGE_LIMIT_WAIT_NOTIFY_EVERY` | `600` | Seconds before the same warning may repeat in one session |
| `USAGE_LIMIT_WAIT_OS_NOTIFICATION` | on | Set to `0` to disable the start and completion desktop notifications |
| `USAGE_LIMIT_WAIT_MAX_WAIT` | `604800` | Longest wait, in seconds (7 days). A reset beyond this is treated as "no subscription" |
| `USAGE_LIMIT_WAIT_POLL` | `60` | Seconds between re-checks while waiting; the final re-check happens after the fixed two-minute post-reset buffer |
| `USAGE_LIMIT_WAIT_CACHE_TTL` | `300` | How long a below-threshold reading stays usable |
| `USAGE_LIMIT_WAIT_IGNORE` | — | Comma-separated window kinds never waited on, e.g. `weekly_all` to accept multi-day waits never happening |
| `USAGE_LIMIT_WAIT_FALLBACK` | on | Claude only: set to `0` to forbid the `claude -p /usage` fallback |

The default threshold of 98% starts the wait just *before* exhaustion, so no
request fails at all. The last couple of percent are discarded at the reset
anyway; use `USAGE_LIMIT_WAIT_THRESHOLD=100` if you want every drop.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers Claude's `UserPromptSubmit` and `PostToolBatch` hooks |
| `.claude/hooks/usage_limit_wait_hook.py` | Claude usage reader and waiter |
| `.codex/hooks.json` | Registers Codex's `UserPromptSubmit` and `PostToolUse` hooks |
| `.codex/hooks/usage_limit_wait_hook.py` | Codex app-server reader and waiter |

Each provider has one script serving both of its events. The Claude variant still
accepts the obsolete `--notify` entry from version 1.1.0 as a no-op.

The `timeout` is the part you cannot omit on the waiter: provider defaults are
measured in seconds or minutes, not days. The installed value matches
`USAGE_LIMIT_WAIT_MAX_WAIT`, and the hook's own cap fires first.

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

Add `--dry` first to see the exact file list and settings diff. A user install
lands in `~/.claude` or `~/.codex`; a local install lands in the matching project
directory. See the [repo README](../../README.md) for installer details.

<details>
<summary>Installing by hand</summary>

For Claude Code:

1. Copy `claude/hooks/usage_limit_wait_hook.py` into `.claude/hooks/`.
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

For Codex, copy `chatgpt/hooks/usage_limit_wait_hook.py` into `.codex/hooks/`
and merge this into `.codex/hooks.json` (replace `python3` when needed):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [{
        "type": "command",
        "command": "python3 \".codex/hooks/usage_limit_wait_hook.py\"",
        "timeout": 604800
      }]}
    ],
    "PostToolUse": [
      {"hooks": [{
        "type": "command",
        "command": "python3 \".codex/hooks/usage_limit_wait_hook.py\"",
        "timeout": 604800
      }]}
    ]
  }
}
```

</details>

Requires a working Python 3 where the installer runs; the Codex variant also
requires the `codex` executable on `PATH`. Windows and macOS need no
additional notification utility; Linux desktop notifications require
`notify-send` (usually supplied by `libnotify`). The waiting behavior itself is
pure Python standard library on every platform.

## Known limits

- If a client clamps the week-long hook timeout, the wait is cut short and the
  client resumes its normal behavior.
- Claude's usage endpoint and `/usage` text layout are not contracts. Codex's
  app-server is experimental and its underlying ChatGPT endpoint is private.
  Every parse is defensive: protocol drift disables waiting rather than
  stalling a healthy session.
- Hook output is buffered until a long-running hook exits. The waiter therefore
  uses an OS notification to announce the pause immediately. <kbd>Esc</kbd>
  interrupts it like another synchronous hook.
- Desktop notifications may be suppressed by Focus Assist / Do Not Disturb or
  by OS notification settings. On Linux, the current desktop session also needs
  a notification service and `notify-send` on `PATH`.
- Notices are per session, tracked below `~/.claude` or `~/.codex`.
  Two sessions near the wall each get told once, which is the point, and a
  session that runs for days keeps only a day of history.
- With `USAGE_LIMIT_WAIT_USE_CREDITS=1` work continues at pay-as-you-go rates
  once a window is exhausted. That spends real money, which is why it is opt-in.
