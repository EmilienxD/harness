# Auto

Platforms: **Claude Code, ChatGPT, Pi**. Installed with [Aboard](aboard.md); it is not independently selectable.

`auto` is Aboard's command bridge on Claude Code, ChatGPT, and Pi. It is installed as a coupled dependency of `aboard` and cannot be selected independently. Use `/auto` or `/auto --dry` in an Aboard-launched Claude session; use `$auto` or `$auto --dry` in ChatGPT. The dry form requests a forecast before starting an Auto Run.

The hook intercepts the command and sends it to the active Aboard session through its local authenticated bridge. It requires Aboard's session and bridge environment, so invoking the command in an ordinary provider session is denied with guidance to launch from the Aboard panel. If the command reaches the skill text itself, the bridge did not intercept it; the skill reports an error rather than starting a run.

Install `aboard`, initialize the VS Code project, and use the Aboard panel to launch a session. Auto Run processes labelled GitHub issues with visible worker terminals and recoverable queue state. The [Aboard page](aboard.md) summarizes setup; the [Aboard README](https://github.com/EmilienxD/harness/blob/main/apps/aboard/README.md) has further details for repository collaborators.

## When to use it

Use `$auto --dry` or `/auto --dry` to inspect the planned issue queue before starting. Use the form without `--dry` after reviewing the forecast. The Aboard panel offers the same forecast and start actions.

## Configure the run

`auto` has no TOML policy. Set the default provider through `autoRun.provider` in `.harness/config.json`; worker launch profiles live at `providers.<provider>.autoRun.explore`, `.address`, and `.review`. Aboard project settings live in `.abd/settings.json`, with `aboard.*` VS Code settings supplying user or profile defaults. For example:

```json
{
  "version": 1,
  "autoRun": { "provider": "chatgpt" }
}
```

Aboard freezes run-specific settings for recovery. New and resumed worker processes read the current launch configuration.

## Behavior and limits

Aboard works through labelled issues and coordinates a RUN branch and pull requests. AFK workers proceed when result and commit checks pass. HITL waits for your single clean acceptance commit. The final pull request stays open for review unless automatic merging is configured and succeeds. The command bridge requires a live Aboard-launched session; its denial message means a run was not queued.

## Pi command bridge

In an Aboard-launched Pi session, use `/auto` or `/auto --dry`. The native extension command invokes the existing authenticated Aboard endpoint without a Pi model turn. Missing session/bridge identity produces an explicit error rather than queuing a run. Install Aboard with its Pi assets and reload Pi; `auto` remains a coupled dependency. Worker launches retain [Aboard's admission and acceptance rules](aboard.md#pi-sessions-and-restrictions).
