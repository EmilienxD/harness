# Prefer Edit Tool

`prefer-edit-tool` is a Claude Code PostToolUse nudge. After shell-based file writes such as redirects, heredocs, `sed -i`, or inline Python, it asks the agent to prefer Claude's Write/Edit tools. It does not undo or block a shell write.

Install with `harness install prefer-edit-tool --platform claude` and restart Claude Code. There is no TOML policy to configure. It applies at the project or user installation scope. ChatGPT is unsupported; its native editing path uses `apply_patch`.

## When to use it

Install it when dedicated edit tool calls make file changes easier to review. For example, a shell command using `sed -i` to alter a file completes, then the hook asks Claude to use Write/Edit for subsequent changes.

## Limits

This hook is advisory. It does not revert the shell write, and it does not offer path filters or configurable exceptions.
