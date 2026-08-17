# redirect-subagents

Redirect Claude Code's built-in `Agent` tool subagents to alternate providers
(`clauder`, `claude -p`, or any CLI you name) instead of letting them burn
your Claude subscription. The native call is denied and the work runs through
the backend you configured, with the result handed back to the agent as if
the subagent had run normally.

```bash
harness install redirect-subagents
```

That installs three hooks into `.claude/hooks/` plus an example
`.claude/harness/subagents.json`, registers them in `.claude/settings.json`,
and gitignores `.claude/harness-redirect-subagents/`. **Install at project
scope** — the hooks read their config from the project root, so a `--user`
install would register hooks that never find their config.

Nothing is intercepted until you edit the config.

## Configuration

`.claude/harness/subagents.json` — one entry per `subagent_type` the Agent
tool might be called with. Three ways to define an entry:

```jsonc
{
  // 1. clauder profile, the original use case. Runs:
  //    clauder run kiro --model claude-haiku-4-5 --effort low --system-prompt "..." "<prompt>"
  "Explore": {
    "profile": "kiro",
    "model": "claude-haiku-4-5",
    "effort": "low",
    "system_prompt": "You are a file search specialist ...",  // optional
    "disabled": false   // true → the native subagent runs instead
  },

  // 2. The "self" shorthand — a plain string. Runs:
  //    claude -p --model auto "<prompt>"
  //    (same CLI, same auth; useful for cheap/explicit model tiers when the
  //    subscription is separately gated for the small model)
  "Plan": "auto",

  // 3. An explicit command template: argv elements separated by ';',
  //    whitespace ok within an element. Substitutions are any config key,
  //    {prompt} and {system_prompt}; unset keys (and the flags that carried
  //    them) drop out. The prompt is appended positionally wherever
  //    {prompt} appears, else at the end.
  "Explore-custom": {
    "command": "kiro-cli;chat;--model;{model};{prompt}",
    "model": "kiro-pro"
  }
}
```

Useful optional key on any entry: `"_append_prompt": false` — don't
substitute `{prompt}` and don't append it; the prompt goes to the backend's
**stdin** instead (keeps it out of `ps` and the Windows process table).
`claude -p` reads its prompt from stdin, so the shorthand could use this
too; it defaults to argv because not every backend does.

### User-level fallback config

`~/.claude/harness/subagents.json` applies in *any* project the file names —
so one shared set of redirected subagents works across every checkout you
list. Entries there lose to the project's own on a name conflict, and run
with their cwd set to your home directory:

```jsonc
{
  "projects": ["C:/dev/my-app", "/home/me/other-app"],
  "agents": {
    "Explore": {"profile": "kiro", "model": "claude-haiku-4-5", "effort": "low"}
  }
}
```

The installer only writes the project file; this one is yours to edit.

## Environment

- **`REDIRECT_SUBAGENTS_CLAUDER_BIN`** — the `clauder` executable, default
  `clauder`. Prepend launcher argv by joining with `;`, e.g.
  `uvx;--from;clauder;clauder` to run it through uvx without a global install.
- **`REDIRECT_SUBAGENTS_BACKEND`** — the command template used for entries
  with `profile`/`model`/`effort` but no `command`, default
  `clauder run {profile} --model {model} --effort {effort} --system-prompt {system_prompt}`.
- **`LOG_LEVEL`** — hook log verbosity, default `INFO`.

## How it works

1. **PreToolUse** (`redirect_subagents_deny_PreToolUse_hook.py`, matcher
   `Agent`): if `subagent_type` names a non-disabled configured entry, the
   native call is denied and run through the configured backend instead.
   `run_in_background: true` (the default) spawns a detached process and
   returns immediately; `false` runs synchronously and the result arrives in
   the deny reason.
2. **Delivery** happens at two points: the **PostToolUse** hook
   (`..._notify_PostToolUse_hook.py`) reports any finished job of this
   session after the next tool call, and the deny hook also intercepts an
   unconfigured-looking Agent call when a report is pending — the result is
   always the thing the agent sees next.
3. **Stop/SubagentStop** (`redirect_subagents_wait_hook.py`): waits for
   running jobs to finish before letting a turn end, so their results land
   while the session can still act on them. On the wait timeout the turn is
   allowed to end anyway — the job keeps running and the next turn's hooks
   deliver it. (Blocking again would re-fire this hook after the next
   message with the same jobs running, and Claude Code overrides a Stop hook
   after 8 consecutive blocks regardless.) Claude Code runs matching Stop
   hooks in parallel, so this one waits alongside any Stop hooks of your own
   rather than in front of them; whichever waiter sees a finished job first
   delivers it, and the rest stop waiting.

### Deferred fallback: the next turn, not this one

If a `clauder`-backed entry fires while `clauder` isn't installed, the
subagent is **deferred** instead of failed: the deny reason tells the agent
to re-issue the exact same Agent call next turn. On that next turn the
PostToolUse hook re-runs the job through `claude -p` (prompt on stdin) and
delivers the result immediately. Only `clauder` entries defer — an explicit
`command` was your choice of backend, and failing it loudly is more honest
than rerouting it.

### Session anchoring

The first hook to run in a session anchors the project root (writing
`.claude/harness-redirect-subagents/root`); later hooks find it by walking
up from cwd, so an in-session `cd` doesn't orphan running jobs. Jobs are
state under `.claude/harness-redirect-subagents/<job-id>/` — logs, exit
code, meta. Anything older than a day is removed by the next PostToolUse
hook run; `.claude/harness-redirect-subagents/` is gitignored by the
installer.

## Uninstall

```bash
harness uninstall redirect-subagents
```

Removes the hooks and their settings entries and drops the gitignore block,
leaving hooks you wrote yourself untouched. A `subagents.json` you modified
is kept; an untouched one goes with the tool.

> Version 1.0.0 briefly rewrote every other Stop/SubagentStop hook to run
> through this tool's wait script, recording the argv it replaced under a
> `_proxied` key. That is gone. Any `harness install` or `harness uninstall`
> restores such an entry to what it was.

## Development

```bash
uv run pytest tests/test_redirect_subagents_hook.py tests/test_installer.py
```
