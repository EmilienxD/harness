# On Edit Reminder

`on-edit-reminder` is a Claude Code PostToolUse hook. It lets a matching edit land, then asks the agent to read required guidance and correct any violations. Use it when feedback after an edit is sufficient.

Install with `harness install on-edit-reminder --platform claude`, restart Claude Code, and configure `.harness/guards/on-edit-reminder.toml` or the user-scope `~/.harness/guards/on-edit-reminder.toml`. The starter has commented examples only:

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/CONVENTIONS.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

Patterns support gitignore-style `*`, `?`, and `**`. Rules run in order; an exclusion clears earlier requirements. User rules load before project rules, and edited starter policies survive upgrades. This is a reminder after the edit, so it cannot prevent that edit. ChatGPT is not supported.

## When to use it

Choose this when an agent may edit first but should check conventions immediately afterward. With the example policy, editing `server/app/models/user.py` prompts a read of `docs/CONVENTIONS.md` and correction of any mismatch. The `vendor/**` exclusion avoids prompting for vendored code.

## Limits

This is feedback to the agent, not an automatic rollback. The initial edit remains on disk while the agent responds. Use `on-edit-block` when reading guidance before the edit is essential.
