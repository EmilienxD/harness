# Auto

Platforms: **Claude Code, ChatGPT, Pi**.

Installed with [Aboard](aboard.md). It is not independently selectable.

The hook intercepts the command and sends it to the active Aboard session through its local authenticated bridge. It requires Aboard's session and bridge environment, so invoking the command in an ordinary provider session is denied with guidance to launch from the Aboard panel.

If the command reaches the skill text itself, the bridge did not intercept it. The skill reports an error rather than starting a run.

Install `aboard`, initialize the VS Code project, and use the Aboard panel to launch a session. Auto Run processes labelled GitHub issues with visible worker terminals and recoverable queue state. The [Aboard page](aboard.md) summarizes setup. The [Aboard README](https://github.com/EmilienxD/harness/blob/main/apps/aboard/README.md) has further details for repository collaborators.

## When to use it

Use `$auto --dry` or `/auto --dry` to inspect the planned issue queue before starting. Use the form without `--dry` after reviewing the forecast. The Aboard panel offers the same forecast and start actions.

## Configure the run

`auto` has no TOML policy. Set the default provider through `autoRun.provider` in `.harness/config.json`. Worker launch profiles live at `providers.<provider>.autoRun.explore`, `.address`, and `.review`. Aboard project settings live in `.abd/settings.json`, with `aboard.*` VS Code settings supplying user or profile defaults. For example:

```json
{
  "version": 1,
  "autoRun": { "provider": "chatgpt" }
}
```

Aboard freezes run-specific settings for recovery. New and resumed worker processes read the current launch configuration.

## Behavior and limits

Aboard works through labelled issues and coordinates a RUN branch and pull requests. AFK workers proceed when result and commit checks pass. HITL waits for your single clean acceptance commit. The final pull request stays open for review unless automatic merging is configured and succeeds. The command bridge requires a live Aboard-launched session. Its denial message means a run was not queued.
