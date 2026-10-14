# On Read Reminder

`on-read-reminder` is a Claude Code PostToolUse hook and a native Pi extension. After the agent reads a path matched by policy, it asks the agent to read the listed guidance files. It does not block the original read.

Install with `harness install on-read-reminder --platform claude`, restart Claude Code, and edit `.harness/guards/on-read-reminder.toml` (or `~/.harness/guards/on-read-reminder.toml` at user scope). The starter contains only commented examples, so add a rule to activate it:

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/GLOSSARY.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

Patterns are gitignore-style paths. Rules are ordered: a matching exclusion clears earlier requirements. User rules load before project rules. Harness preserves edited starter policies during upgrades. ChatGPT is not supported.

## When to use it

Choose this when reading source files should prompt the agent to consult a nearby glossary or convention file. For the example above, reading `server/app/models/user.py` requests `docs/GLOSSARY.md`; reading `vendor/lib/models/item.py` is excluded by the later rule.

## Limits

The reminder runs after the triggering read. It asks the agent to follow up; it does not itself read the required file or guarantee compliance. Add only paths that exist in the relevant project so the requested follow-up is actionable.

For Pi, install with `harness install on-read-reminder --platform pi` and run `/reload` or restart Pi.
Approve the project's resources when Pi requests trust. Project rules use the same
`.harness/guards/on-read-reminder.toml`. User installations keep an editable starter in
`<Pi agent directory>/hooks/on-read-reminder.toml`; shared `~/.harness/guards/` rules and
project rules load afterward. Pi requires uv or Python 3.11+ on `PATH`.

Pi reminds after successful native `read` and recognized `bash`/`powershell` reads, including partial reads. Failed reads produce no reminder. Each successful matching read can remind again.
