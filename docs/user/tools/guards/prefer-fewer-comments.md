# Prefer Fewer Comments

`prefer-fewer-comments` checks newly added comments and docstrings after a write in Claude Code or ChatGPT. When a comment, docstring, or the overall change exceeds a budget, it asks the agent to trim commentary. It is a PostToolUse preference, so the write has already happened.

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

## When to use it

Use this when generated comments and docstrings tend to crowd out code. The built-in limits apply with the shipped commented starter, so installation has an effect before customization. For example, exempting `docs/**` lets documentation files exceed code-oriented comment budgets while retaining checks on source files.

## Limits

The hook inspects what the write added and returns feedback after the write. It does not delete comments automatically. Ratio checks apply only when the change reaches `min_lines_for_ratio`; the line and character budgets can still flag smaller additions.
