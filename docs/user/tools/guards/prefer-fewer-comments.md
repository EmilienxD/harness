# Prefer Fewer Comments

`prefer-fewer-comments` checks newly added comments and docstrings after a write in Claude Code, ChatGPT, or Pi. When a comment, docstring, or the overall change exceeds a budget, it asks the agent to use less commentary going forward. Writes remain successful; existing comments stay in place. Functional comments and docstrings can exceed the budget.

Install with `harness install prefer-fewer-comments` and restart the provider. Edit `.harness/guards/prefer-fewer-comments.toml` or `~/.harness/guards/prefer-fewer-comments.toml` at user scope. The commented starter uses built-in defaults until you set values:

```toml
version = 1

[limits]
max_comment_lines = 2
max_comment_chars = 240
max_doc_lines = 5
max_doc_chars = 600
max_comment_ratio = 0.30
min_lines_for_ratio = 20

[[rules]]
patterns = ["docs/**", "**/*.md"]
exempt = true
```

Each limit is optional. Ordered path rules can set `exempt = true` and a later, narrower `exempt = false` to include a path again. User rules precede project rules; edited starter files survive upgrades.

## Pi

Install with `harness install prefer-fewer-comments --platform pi`, then run `/reload` and approve the project resources. The shipped defaults are active immediately. Project policy uses `.harness/guards/prefer-fewer-comments.toml`. A user installation puts its starter in the effective Pi agent directory at `hooks/prefer-fewer-comments.toml`; shared `~/.harness/guards/prefer-fewer-comments.toml` and project overrides take precedence. Pi requires uv or Python 3.11+.

The extension wraps local native `write` and `edit`, including nested calls. It captures the old contents and the exact written contents inside Pi's file mutation queue, then checks additions after successful execution. Unchanged comment bodies are excluded even when neighboring code changes. Existing line comments are excluded before new adjacent lines are grouped; a changed block comment or docstring is checked as a complete comment. The ratio counts added lines only. Native paths, edit matching, multi-edit input, BOM/line endings, diffs, renderers, and other extensions' tool guards remain intact.

Each file gets at most one reminder every 180 seconds. Cooldown receipts persist in Pi's native session ancestry, survive reload/resume, and follow the selected branch. They contain paths, times, call IDs and interpreter launch arguments. Full snapshots stay in memory; Pi persists ordinary tool results, including reminder excerpts. Failed or cancelled calls consume no reminder. Analysis failure or snapshots over 512 KiB append a diagnostic while preserving successful writes.

This extension owns the `write` and `edit` definitions. Use it with Pi's local filesystem tools; another extension replacing those names, such as a remote filesystem adapter, requires explicit integration. Shell commands, MCP mutators, and direct filesystem writes by other extensions are outside Pi coverage. This is advisory feedback, not a mutation restriction. Acceptance uses headless Pi 1.2.0 on Windows; other Pi versions, POSIX and TUI behavior need their own runtime verification.

## When to use it

Use this when generated comments and docstrings tend to crowd out code. The built-in limits apply with the shipped commented starter, so installation has an effect before customization. For example, exempting `docs/**` lets documentation files exceed code-oriented comment budgets while retaining checks on source files.

## Limits

The hook inspects what the write added and returns feedback after the write. It does not delete comments automatically. Ratio checks apply only when the change reaches `min_lines_for_ratio`; the line and character budgets can still flag smaller additions.
