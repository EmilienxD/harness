# Redirect Subagents

Platforms: **Claude Code**.

Install with `harness install redirect-subagents --platform claude`. See [installation and scope](../../getting-started.md).

`redirect-subagents` intercepts configured Claude Code built-in Agent subagents and runs them through another command or provider, returning the result to the parent session. It is Claude-only and separate from Harness's `subagents` delegation package.

Install with `harness install redirect-subagents --platform claude` and restart Claude Code. Edit the installed starter at `.claude/harness-redirect-subagents/subagents.json`. Its `Explore` example has `disabled: true`, so no route is active until you enable one. A simple route is:

```json
{
  "Explore": "auto"
}
```

The shorthand runs `claude -p --model auto`. An object can instead specify `command`, or `profile`, `model`, and `effort` for the `clauder` backend.  `disabled: true` turns a route off. The chosen executable must be available on the host.

Project routes override user routes. User definitions live at `~/.claude/harness-redirect-subagents/subagents.json` under `agents` and need a `projects` list of allowed project roots. The installed directory also contains git-ignored local job state. Harness preserves the edited starter on upgrade.

## When to use it

Install this when you want particular built-in Claude Agent tasks, such as `Explore`, handled through another configured backend. It changes those Agent calls. It does not change top-level Claude sessions or Harness manual delegation commands.

## Example and limits

With `"Explore": "auto"`, an Explore Agent call routes to `claude -p --model auto` and its result returns to the parent. Keep the `disabled` flag in place until the backend command is installed and tested. Routes are local configuration. A missing executable or failed child command cannot produce a successful redirected result.

## Pi status

This intercepts Claude Code's built-in Agent tool and remains Claude-only. Pi delegation belongs to the persistent subagents workflow.
