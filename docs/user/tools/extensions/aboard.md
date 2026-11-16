# Aboard

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install aboard`. See [Get started](../../getting-started.md) for provider and scope options.

## When to use it

Manage agent conversations from VS Code. Inspect visible terminals and return to earlier work. Process a queue of labeled GitHub issues with Auto Run.

## Start a session

Install Aboard and reload VS Code. Open your project and initialize it in the Aboard panel. Choose **Run Agent**, **Run Claude Code**, or **Run Codex**. Use **Agent Fleet** to inspect active work and **Recent Activity** for completed work. Select a background agent or run **Aboard: Watch Background Agent** to read its progress.

## Use Auto Run

Review the issue forecast in the panel before starting. Use `/auto --dry` in an Aboard-launched Claude Code session or `$auto --dry` in ChatGPT to preview the queue. Start from the panel or use `/auto` or `$auto`. AFK mode accepts a successful worker result with one clean commit. HITL mode waits for you to accept work by creating one nonempty commit with a clean working tree.

Review the final pull request before merging unless you have deliberately enabled automatic merging. Interrupted runs retain recovery state.

## Practical limits

Install and authenticate the providers you want to launch. Use [Configuration](../../configuration.md#agent-launches) for provider and launch defaults. A working directory and tool restrictions do not provide operating-system isolation.
