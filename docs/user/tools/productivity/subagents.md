# Subagents

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install subagents`. See [Get started](../../getting-started.md) for provider and scope options.

## When to use it

Delegate a focused task without losing the conversation when the first answer arrives. Use a visible child session when you want to participate. Use automatic mode for background work. Continue an earlier child conversation rather than explaining the task again.

## Start delegated work

Invoke the toolkit and describe the task you want to delegate:

| Agent | Command |
| --- | --- |
| Claude Code | `/subagents-toolkit` |
| ChatGPT | `$subagents-toolkit` |
| Pi | `/skill:subagents-toolkit` |

Specify the child provider if you have a preference. Supported choices are `claude`, `chatgpt`, and `pi`. Ask for `mode: auto` to run in the background. The default is `mode: interactive`.

Name a child skill only when you want that specific workflow. Install it separately for the child provider. Choose model and effort independently of the skill.

## Return a result

In an interactive child, use `reply-to-agent` to return its next successful response. On Pi, `/reply-to-agent-with-previous-message` returns the previous answer without generating a new one. Automatic children return their results when finished. A parent can receive results while working or waiting.

## Continue and inspect work

Ask the toolkit to resume `agent-i`, using the child's identifier and your follow-up request. Resuming retains the provider, mode, model, effort, working directory, and conversation. Use `harness watch <session-id|agent-i>` to follow background progress. Add `--once` to show progress recorded so far.

## Persistent commands

```text
harness run --provider claude|chatgpt|pi [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible session. `ask` processes delegation requests for a parent. `reply` prepares an interactive child to return its next successful answer. These commands manage conversations. They are separate from tool installation.

## Before you start

Install and authenticate each provider you want children to use. Restart your agent after installing the tool. Use [Configuration](../../configuration.md#agent-launches) to customize launch defaults. Install child skills separately. Missing requested skills stop the launch. Pi background children need trusted project resources or a user-scope installation for nested delegation.
