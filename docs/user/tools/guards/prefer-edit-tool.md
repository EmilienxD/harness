# Prefer Edit Tool

Platforms: **Claude Code**.

Install with `harness install prefer-edit-tool --platform claude`. See [installation and scope](../../getting-started.md).

`prefer-edit-tool` is a Claude Code reminder. After shell-based file writes such as redirects, heredocs, `sed -i`, or inline Python, it asks the agent to prefer Claude's Write/Edit tools. It does not undo or block a shell write.

Install with `harness install prefer-edit-tool --platform claude` and restart Claude Code. There is no TOML policy to configure. It applies at the project or user installation scope. ChatGPT is unsupported. Its native editing path uses `apply_patch`.

## When to use it

Install it when dedicated edit tool calls make file changes easier to review.

For example, a shell command using `sed -i` to alter a file completes, then the hook asks Claude to use Write/Edit for subsequent changes.

## Limits

This hook is advisory. It does not revert the shell write, and it does not offer path filters or configurable exceptions.

## Pi status

This tool nudges Claude Code's Write/Edit tools and remains Claude-only. No Pi port is planned.
