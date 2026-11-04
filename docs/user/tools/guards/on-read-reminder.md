# On Read Reminder

Platforms: **Claude Code, ChatGPT (local Work/Codex), Pi**. Install with `harness install on-read-reminder`; see [installation and scope](../../getting-started.md).

`on-read-reminder` uses Claude Code/ChatGPT PostToolUse hooks and a native Pi extension. After the agent reads a path matched by policy, it asks the agent to read the listed guidance files. It does not block the original read.

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

Patterns are gitignore-style paths. Rules are ordered: a matching exclusion clears earlier requirements. User rules load before project rules. Harness preserves edited starter policies during upgrades. ChatGPT support uses local hooks; cloud-orchestrated Work does not load these command hooks.

## When to use it

Choose this when reading source files should prompt the agent to consult a nearby glossary or convention file. For the example above, reading `server/app/models/user.py` requests `docs/GLOSSARY.md`; reading `vendor/lib/models/item.py` is excluded by the later rule.

## Limits

The reminder runs after the triggering read. It asks the agent to follow up; it does not itself read the required file or guarantee compliance. Add only paths that exist in the relevant project so the requested follow-up is actionable.

For Pi, install with `harness install on-read-reminder --platform pi` and run `/reload` or restart Pi.
Approve the project's resources when Pi requests trust. Project rules use the same
`.harness/guards/on-read-reminder.toml`. User installations keep an editable starter in
`<Pi agent directory>/harness/on-read-reminder.toml`; shared `~/.harness/guards/` rules and
project rules load afterward. Pi requires uv or Python 3.11+ on `PATH`.

Pi reminds after successful native `read` and recognized `bash`/`powershell` reads, including partial reads. Failed reads produce no reminder. Each successful matching read can remind again.

## ChatGPT and Claude behavior

Install for local ChatGPT with `harness install on-read-reminder --platform chatgpt`, then review/trust the installed hooks and restart the session. ChatGPT recognizes supported shell reads; Claude retains native `Read` coverage and also recognizes shell reads. Both return the reminder as additional model context after the read. Failed calls produce no reminder; successful partial reads can trigger it.

Project rules and required guidance resolve from the directory where the session started. Codex uses the hook process directory; Claude uses `CLAUDE_PROJECT_DIR`. Relative tool targets use the call's working directory, including `exec_command.workdir` and recognized shell `cd` commands. Starting in a child directory does not load policies from ancestors.

## Implementation and verification

The [read/edit guard implementation](../guards-and-extensions.md#readedit-guard-implementation-and-verification) describes shared Python policy reuse, bounded transport, active-branch receipts and the Windows Pi 1.2.0 project/user JSON/RPC journeys. This tool retains the triggering and cooldown rules described above. Guard loading, unknown mutators and operating-system isolation follow the [admission limits](../guards-and-extensions.md#guard-admission-and-evidence).
