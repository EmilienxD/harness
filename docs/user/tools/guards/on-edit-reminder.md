# On Edit Reminder

Platforms: **Claude Code, ChatGPT (local Work/Codex), Pi**. Install with `harness install on-edit-reminder`; see [installation and scope](../../getting-started.md).

`on-edit-reminder` uses Claude Code/ChatGPT PostToolUse hooks and a native Pi extension. It lets a matching edit land, then asks the agent to read required guidance and correct any violations. Use it when feedback after an edit is sufficient.

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

Patterns support gitignore-style `*`, `?`, and `**`. Rules run in order; an exclusion clears earlier requirements. User rules load before project rules, and edited starter policies survive upgrades. This is a reminder after the edit, so it cannot prevent that edit. ChatGPT support uses local hooks; cloud-orchestrated Work does not load these command hooks.

## When to use it

Choose this when an agent may edit first but should check conventions immediately afterward. With the example policy, editing `server/app/models/user.py` prompts a read of `docs/CONVENTIONS.md` and correction of any mismatch. The `vendor/**` exclusion avoids prompting for vendored code.

## Limits

This is feedback to the agent, not an automatic rollback. The initial edit remains on disk while the agent responds. Use `on-edit-block` when reading guidance before the edit is essential.

For Pi, install with `harness install on-edit-reminder --platform pi` and run `/reload` or restart Pi.
Approve the project's resources when Pi requests trust. Project rules use the same
`.harness/guards/on-edit-reminder.toml`. User installations keep an editable starter in
`<Pi agent directory>/harness/on-edit-reminder.toml`; shared `~/.harness/guards/` rules and
project rules load afterward. Pi requires uv or Python 3.11+ on `PATH`.

Pi reminds after successful native `write`/`edit` and recognized shell writes, with a 120-second cooldown per guidance file. A complete successful guidance read on the active branch suppresses further reminders. Failed edits produce no reminder.

## ChatGPT and Claude behavior

Install for local ChatGPT with `harness install on-edit-reminder --platform chatgpt`, then review/trust the installed hooks and restart the session. ChatGPT observes successful `apply_patch` calls; Claude retains `Write`/`Edit`/`MultiEdit` coverage. Both also recognize common shell writes. The reminder arrives as additional model context after the operation, without rolling it back.

Reminders keep the 120-second cooldown per guidance file. Successful reads covering the complete current guidance suppress reminders; attempted, failed or incomplete reads do not. Read evidence is scoped to provider, project and session while the hooks are active.

ChatGPT shell coverage uses the session directory and explicit `cd` commands. The tested Codex CLI does not expose per-call `exec_command.workdir` overrides to hooks; relative paths under such overrides cannot be resolved reliably. Use absolute paths or an explicit `cd` for those calls.

## Implementation and verification

The [read/edit guard implementation](../guards-and-extensions.md#readedit-guard-implementation-and-verification) describes shared Python policy reuse, bounded transport, active-branch receipts and the Windows Pi 1.2.0 project/user JSON/RPC journeys. This tool retains the triggering and cooldown rules described above. Guard loading, unknown mutators and operating-system isolation follow the [admission limits](../guards-and-extensions.md#guard-admission-and-evidence).
