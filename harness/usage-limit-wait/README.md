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

### Two hooks, not one

On each of those events, two hooks are registered — the same script, in two
modes. Hooks on one event run in parallel, so the notifier finishes in
milliseconds and tells you what is about to happen while the waiter is already
asleep:

| Mode | Blocks? | Job |
|---|---|---|
| `--notify` | never | Says where usage stands: nothing while there's headroom, a warning near the wall, and an announcement of the pause before it starts |
| `--wait` | for hours | Sleeps until the window resets, then lets the turn continue |

One process could not do both. A message printed by the waiter arrives when the
wait is already over, which is the wrong end of a three-hour silence.

### What you actually see

Nothing at all below 90% — the common case is a hook that prints nothing.

```
Claude usage: the 5-hour window is 94% used and resets at 15:59, in 1h04m.
The session will pause here by itself if it runs out.

Claude usage limit reached: the 5-hour window is 100% used. Pausing until
15:59, about 1h04m, then carrying on by itself. Esc interrupts the wait.

usage-limit-wait: waited 1h04m for the 5-hour limit to reset.
```

The warning repeats at most once every 10 minutes per session
(`USAGE_LIMIT_WAIT_NOTIFY_EVERY`); the pause announcement is never throttled,
because it precedes an actual stop. When the pause is *not* going to happen —
credits opted into, no reset time reported, a reset past the cap — the notice
says so instead of promising a wait that never comes.

Starting and finishing a wait also emit a terminal bell and an OSC 777 desktop
notification, so a session you walked away from can tell you it's back.
`USAGE_LIMIT_WAIT_BELL=0` turns that off.

### It fails open, always

The hook is only meaningful for a Claude subscription, and it exits 0 —
silently, changing nothing — the moment anything says otherwise:

| Situation | How it's detected |
|---|---|
| Direct API key, or a bearer-token gateway | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` set |
| Bedrock, Vertex, or Foundry | `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` / `_USE_FOUNDRY` |
| Logged out, or a third-party CLI | no OAuth token in `~/.claude/.credentials.json` |
| Expired session, revoked access, endpoint down | the usage request fails, or the reading can't be parsed |
| Reset is more than `MAX_WAIT` (7 days) away | there is no live subscription behind this session |

It never blocks a tool call, never rejects a prompt, and never writes to the
model's context. All it can print is a `systemMessage` and a `terminalSequence`
— both shown to you, neither to Claude.

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
minutes below the warning level, 30 seconds from there to the threshold, 15
seconds once a window is exhausted — just long enough for the notifier and the
waiter, which start together, to read usage once and agree about it. Failures
are cached too, so a machine on an API key pays one wasted request every 5
minutes rather than one per prompt. **Zero model calls** — the hook never talks
to a model.

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
| `USAGE_LIMIT_WAIT_BELL` | on | Set to `0` to drop the bell and desktop notification |
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
| `.claude/settings.json` | Registers `--notify` and `--wait` on both `UserPromptSubmit` and `PostToolBatch` — four entries, two per event |
| `.claude/hooks/usage_limit_wait_hook.py` | Reads usage, reports it, and blocks until the reset |

One script serves both events and both modes — it needs nothing
event-specific — which is why its filename has no `_<Event>_` infix like the
other hooks in this repo. An entry with no arguments runs the waiter, so an
installation that predates the split keeps working.

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
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py", "--notify"],
            "timeout": 120,
            "statusMessage": "Checking Claude usage limits"
          },
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py", "--wait"],
            "timeout": 604800,
            "statusMessage": "Waiting for the Claude usage limit to reset"
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
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py", "--notify"],
            "timeout": 120,
            "statusMessage": "Checking Claude usage limits"
          },
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/usage_limit_wait_hook.py", "--wait"],
            "timeout": 604800,
            "statusMessage": "Waiting for the Claude usage limit to reset"
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

Requires a working Python 3 where the installer runs, and nothing else — the
hook is pure standard library.

## Known limits

- The docs give no maximum for a hook `timeout`. If Claude Code clamps 604800,
  a long wait is cut short; that fails open (a cancelled hook's output is
  discarded and the session proceeds as it would without the hook).
- The usage endpoint is undocumented and unversioned, and the `/usage` text
  layout is not a contract either. Every parse is defensive: if both drift, the
  hook degrades to doing nothing, never to stalling a session wrongly.
- `statusMessage` is documented but is not always rendered while a hook runs,
  which is why the notifier exists at all: its `systemMessage` is what actually
  reaches you. While the waiter sleeps you see the spinner and nothing else.
  <kbd>Esc</kbd> interrupts it like any other hook.
- Notices are per session, tracked in `~/.claude/.usage-limit-wait.notices.json`.
  Two sessions near the wall each get told once, which is the point, and a
  session that runs for days keeps only a day of history.
- With `USAGE_LIMIT_WAIT_USE_CREDITS=1` work continues at pay-as-you-go rates
  once a window is exhausted. That spends real money, which is why it is opt-in.
