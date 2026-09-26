# Prefer Read Tool

`prefer-read-tool` is a Claude Code PostToolUse nudge. After a shell-based file read, it asks the agent to use Claude's reviewable Read tool for file reads. It does not block the shell command.

Install with `harness install prefer-read-tool --platform claude` and restart Claude Code. There is no TOML policy or rule list to edit. It applies wherever the Claude hook is installed, at project or user scope. ChatGPT is unsupported because its local reading workflow differs from Claude's Read tool.

## When to use it

Install this when you want file reads to appear as dedicated Read tool calls for easier inspection. For example, after Claude reads a source file with `cat`, the hook reminds it to use Read next time.

## Limits

It is advisory and runs after the shell call, so the original read completes. There are no per-path exceptions or numeric settings.
