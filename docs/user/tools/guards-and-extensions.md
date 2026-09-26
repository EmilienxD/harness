# Guards and extensions

Guards are hooks: install one, then restart Claude Code or ChatGPT so the provider reloads its hook registration. Run the Harness catalogue to choose packages, platforms, and project or user scope:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

For a scripted project install, use `harness install command-guard no-new-documents`; add `--platform claude` or `--platform chatgpt` when needed. `--scope user` installs at user scope, and `--root <path>` chooses another project. Use `harness list` to inspect selections and `harness info <name>` for package details. Installed starter policies are preserved when you upgrade.

| Package | Platforms | Behavior |
| --- | --- | --- |
| [`command-guard`](guards/command-guard.md) | Claude Code, ChatGPT | Denies shell commands matching policy regular expressions. This is a guardrail, not a security sandbox. |
| [`no-new-documents`](guards/no-new-documents.md) | Claude Code, ChatGPT | Sends new files in protected documentation paths to user-approved drafts; existing files remain editable. |
| [`on-read-reminder`](guards/on-read-reminder.md) | Claude Code | Prompts the agent to read required guidance after it reads matching paths. |
| [`on-edit-reminder`](guards/on-edit-reminder.md) | Claude Code | Allows a matching edit, then asks the agent to read guidance and correct violations. |
| [`on-edit-block`](guards/on-edit-block.md) | Claude Code | Denies a matching edit until required guidance has been read in the session. |
| [`prefer-read-tool`](guards/prefer-read-tool.md) | Claude Code | Nudges the agent toward Read after shell-based file reads. |
| [`prefer-edit-tool`](guards/prefer-edit-tool.md) | Claude Code | Nudges the agent toward Write/Edit after shell-based file changes. |
| [`prefer-fewer-comments`](guards/prefer-fewer-comments.md) | Claude Code, ChatGPT | Flags added comments or docstrings above configurable budgets. |
| [`redirect-subagents`](guards/redirect-subagents.md) | Claude Code | Routes configured built-in Agent subagents through alternate commands or providers. |
| [`usage-limit-wait`](guards/usage-limit-wait.md) | Claude Code, ChatGPT | Waits for an exhausted subscription window to reset; usage-reader errors fail open. |
| [`aboard`](extensions/aboard.md) | Claude Code, ChatGPT | Installs the Aboard VS Code extension for visible sessions and Auto Run. |
| [`auto`](extensions/auto.md) | Claude Code, ChatGPT | Provides Aboard's `/auto` bridge (`$auto` in ChatGPT); installed with Aboard and not independently selectable. |

## Configure guard policies

Editable policies live at `.harness/guards/<package>.toml` for a project or `~/.harness/guards/<package>.toml` for user scope. All begin with `version = 1`. User rules load first and project rules follow; ordered exclusions or exemptions can override earlier matches. The `.claude/` and `.codex/` folders contain provider hook registration and executables, not these policies. The `prefer-read-tool`, `prefer-edit-tool`, `redirect-subagents`, and `usage-limit-wait` packages have no TOML starter policy.

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

`command-guard.toml` groups each reason with command-matching regular expressions. Its starter already includes dangerous shell, Git, credential, and Windows command patterns. For example:

```toml
version = 1

[[rules]]
reason = "network content piped into a shell"
patterns = ['''(curl|wget).*\|\s*(ba|z)?sh''']
```

In `no-new-documents.toml`, `protected` contains path patterns. The default is `protected = ["**/docs/**"]`; add paths such as `"project-notes/**"` if needed. If a new `docs/arch/plan.md` is blocked, the agent writes `.harness/doc-drafts/docs/arch/plan.md`. Review it, then run `/approve-doc-draft docs/arch/plan.md` or `/reject-doc-draft docs/arch/plan.md` in Claude Code; use `$approve-doc-draft` or `$reject-doc-draft` in ChatGPT. Run either command without a path to list drafts. A directory path handles its pending drafts together. Approval never overwrites an existing target file.

`prefer-fewer-comments.toml` has optional `[limits]` values such as `max_comment_lines = 2`, `max_doc_lines = 5`, and `max_comment_ratio = 0.30`. Use ordered `[[rules]]` entries with `patterns = ["docs/**"]` and `exempt = true` to exempt paths, then a later `exempt = false` rule to include a narrower path again. Its starter comments list all settings and defaults.

## Redirect Claude Code subagents

Edit the installed `.claude/harness-redirect-subagents/subagents.json` to enable a route. Its starter `Explore` entry is disabled. A project entry can be as simple as:

```json
{
  "Explore": "auto"
}
```

That shorthand runs `Explore` through `claude -p --model auto`. For another backend, configure an object with a `command`, or with a `profile`, `model`, and `effort` for the `clauder` backend; set `disabled: true` to turn an entry off. The named backend executable must be available on the host. Project entries take precedence over user entries. User definitions live at `~/.claude/harness-redirect-subagents/subagents.json` under `agents` and require a `projects` list naming each allowed project root. The directory also holds local job state and is git-ignored by the installed starter.

## Aboard and Auto Run

Select `aboard` to install its verified VSIX and required worker assets. Harness installs the coupled `auto` bridge with it, plus the reusable `issue-readers` dependency. In VS Code, initialize the project once, then choose **Run Agent**, **Run Claude Code**, or **Run Codex** in the Aboard panel to open an attended terminal. **Agent Fleet** shows live sessions; **Recent Activity** keeps completed work available for inspection and supported reopen flows. Select a background agent in the Fleet, or run **Aboard: Watch Background Agent**, to follow its read-only progress.

Auto Run processes labelled GitHub issues in a recoverable queue. Review its forecast in the panel or run `/auto --dry` in an Aboard-launched Claude session (`$auto --dry` in ChatGPT). Start it from the panel or use `/auto` (`$auto` in ChatGPT) when the forecast is right. The hook requires an active Aboard session. Auto Run uses visible worker terminals; its one-shot, read-only exploration runs in the background. It coordinates a RUN branch and issue work, then leaves the final pull request for review unless automatic merging is configured and succeeds.

Project launch settings live in `.harness/config.json`; Aboard settings live in `.abd/settings.json`, with `aboard.*` VS Code settings providing user or profile defaults. A minimal launch config is `{ "version": 1 }`; omitted values use product defaults. Existing terminals keep their launch settings, while new launches read the current config. The [Aboard README](https://github.com/EmilienxD/harness/blob/main/apps/aboard/README.md) has more settings and workflow details for repository collaborators.
