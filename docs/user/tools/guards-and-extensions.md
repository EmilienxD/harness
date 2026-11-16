# Guards and extensions

Guards install provider hooks or native Pi extensions. Install one, then restart the selected provider so it reloads the registration. Run the Harness catalogue to choose packages, platforms, and project or user scope:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

For a scripted project install, use `harness install command-guard no-new-documents`. Add `--platform claude` or `--platform chatgpt` when needed. For Pi document protection, use `harness install no-new-documents --platform pi`. `--scope user` installs at user scope, and `--root <path>` chooses another project. Use `harness list` to inspect selections and `harness info <name>` for package details.

Installed starter policies are preserved when you upgrade.

| Package | Platforms | Purpose |
| --- | --- | --- |
| [`aboard`](extensions/aboard.md) | Claude Code, ChatGPT, Pi | Aboard VS Code integration for interactive and background agents and Auto Run |
| [`auto`](extensions/auto.md) | Claude Code, ChatGPT, Pi | Routes /auto and /auto --dry to an active Aboard session |
| [`command-guard`](guards/command-guard.md) | Claude Code, ChatGPT, Pi | Guard that denies configured dangerous Bash and PowerShell commands |
| [`exclude-unwanted-tools`](guards/exclude-unwanted-tools.md) | Pi | Exclude powershell, codemode, find, grep, and ls from Pi's tool registry |
| [`no-new-documents`](guards/no-new-documents.md) | Claude Code, ChatGPT, Pi | Cross-platform guard that routes new files in configured documentation directories through user-approved drafts |
| [`on-edit-block`](guards/on-edit-block.md) | Claude Code, ChatGPT, Pi | Blocks edits on files matching gitignore-style patterns until the agent has read the required files |
| [`on-edit-reminder`](guards/on-edit-reminder.md) | Claude Code, ChatGPT, Pi | Lets edits to files matching gitignore-style patterns land, then makes the agent read the required files and fix what doesn't follow them |
| [`on-read-reminder`](guards/on-read-reminder.md) | Claude Code, ChatGPT, Pi | Reminds the agent to read key files when it reads paths matching gitignore-style patterns |
| [`prefer-edit-tool`](guards/prefer-edit-tool.md) | Claude Code | Reminder to prefer the Write/Edit tools over heredocs, redirects, sed -i and inline python for file writes |
| [`prefer-fewer-comments`](guards/prefer-fewer-comments.md) | Claude Code, ChatGPT, Pi | Advisory comment and docstring budgets over newly written commentary, with native Pi mutation snapshots |
| [`prefer-read-tool`](guards/prefer-read-tool.md) | Claude Code | Reminder to prefer the Read tool over shell file-read commands |
| [`redirect-subagents`](guards/redirect-subagents.md) | Claude Code | Redirect Claude Code's built-in Agent tool subagents to alternate providers, avoiding Claude subscription usage |
| [`slash-command-guard`](guards/slash-command-guard.md) | Pi | Reject unknown leading slash commands in Pi before they reach the model |
| [`usage-limit-wait`](guards/usage-limit-wait.md) | Claude Code, ChatGPT | Blocks the session until an exhausted Claude or ChatGPT subscription usage window resets, instead of failing the turn |

## Configure guard policies

Editable policies live at `.harness/guards/<package>.toml` for a project or `~/.harness/guards/<package>.toml` for user scope. All begin with `version = 1`. User rules load first and project rules follow. Ordered exclusions or exemptions can override earlier matches. The `.claude/` and `.codex/` folders contain provider hook registration and executables, not these policies.

The `prefer-read-tool`, `prefer-edit-tool`, `redirect-subagents`, and `usage-limit-wait` packages have no TOML starter policy.

The three read/edit guards share ordered rules with gitignore-style path patterns (`*`, `?`, `**`). Put this example in the corresponding `on-edit-block.toml`, `on-edit-reminder.toml`, or `on-read-reminder.toml` and choose the timing you need:

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/CONVENTIONS.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

The installed read/edit policies contain commented examples, so configure at least one rule to make them useful. A matching exclusion clears requirements from earlier rules.

Each tool guide owns its policy schema, invocation, examples and provider differences. Open [No New Documents](guards/no-new-documents.md) for draft approval, [comment budgets](guards/prefer-fewer-comments.md) for comment limits, [subagent redirection](guards/redirect-subagents.md) for Claude routing, or [Aboard](extensions/aboard.md) and [Auto](extensions/auto.md) for visible workers and queue control.
