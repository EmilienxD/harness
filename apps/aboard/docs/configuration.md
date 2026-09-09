# Configuration

Aboard launch policy is committed in `.abd/launch.json`. Other `aboard.*` settings are edited in VS Code Settings and may be overridden by an optional committed `.abd/settings.json`.

## Launch configuration

Initialization creates:

```json
{
  "version": 1,
  "platform": "claude",
  "command": ["claude"],
  "interactive": {
    "model": "inherit",
    "effort": "inherit",
    "deniedTools": ["Agent", "WebSearch", "WebFetch"]
  },
  "explore": {
    "model": "haiku",
    "effort": "low"
  },
  "implementer": {
    "model": "by-difficulty",
    "effort": "by-difficulty",
    "deniedTools": ["Agent", "WebSearch", "WebFetch"]
  },
  "reviewer": {
    "model": "by-difficulty",
    "effort": "by-difficulty",
    "deniedTools": ["Agent", "WebSearch", "WebFetch"]
  }
}
```

`platform` is required and selects the agent runtime explicitly. It is not inferred from `command`, because that command may begin with a wrapper, package runner, Windows path, or remote executor. This release supports `claude` and `chatgpt` for every session kind. A missing or unknown platform blocks launches with a diagnostic that names the field to fix.

The remaining fields are validated by the selected platform. For `claude`, `command` is a non-empty array containing the executable followed by wrapper arguments, and Aboard appends Claude Code's launch flags. `model` accepts `haiku`, `sonnet`, or `opus`; Interactive and Explore also accept `inherit`, while implementer and reviewer accept `by-difficulty`. `effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`, with the same profile-specific `inherit` and `by-difficulty` values. Models or effort values belonging to another platform are rejected before a terminal is created.

For an attended ChatGPT session, select the Codex CLI explicitly:

```json
{
  "version": 1,
  "platform": "chatgpt",
  "command": ["codex"],
  "interactive": {
    "model": "inherit",
    "effort": "inherit"
  },
  "explore": {
    "model": "inherit",
    "effort": "low"
  },
  "implementer": {
    "model": "by-difficulty",
    "effort": "by-difficulty",
    "webSearch": "disabled",
    "subagents": "denied"
  }
}
```

ChatGPT `command` has the same wrapper-friendly array shape and defaults to `["codex"]`. Its Interactive and Explore `model` accepts `inherit` or a non-empty Codex model slug; the implementer and reviewer `model` also accepts `by-difficulty`. `effort` accepts `inherit`, `minimal`, `low`, `medium`, `high`, or `xhigh`, and `by-difficulty` for the workers. Aboard launches the ordinary visible Codex TUI, waits for its lifecycle handshake, and replaces its provisional launch ownership with the actual Codex session id. Reopen checks the saved conversation with Codex App Server's supported `thread/read` operation, then starts the configured command as `codex resume <session-id>` and waits for the resume handshake before reporting it live. Missing conversations, unreadable saved state, runtime launch failures, and startup timeouts have separate diagnostics. Aboard passes only the hook-trust bypass needed by its generated lifecycle hooks; it never passes Codex's approvals-and-sandbox bypass.

A ChatGPT Auto Run worker is a visible top-level Codex session whose first prompt invokes the installed skill for its role — `$address-issue` for an implementer, `$issue-review` for a reviewer in either AFK or HITL mode — with the frozen issue and pull-request contract. A resume continues that same conversation without repeating the invocation. Codex has no tool-rule syntax, so Aboard enforces the same worker boundary through Codex's own settings: `webSearch` maps to Codex's `web_search` mode and defaults to `disabled`, `subagents: "denied"` turns off `features.multi_agent` and `agents.enabled`, and Aboard's Git and GitHub denials become a `PreToolUse` guard hook that denies matching shell commands and `spawn_agent` calls. Those two fields are accepted only on the `implementer` and `reviewer` profiles, and a resume carries all of them unchanged. Aboard verifies that `$address-issue` and `$issue-review` resolve from `.agents/skills`, the user's `~/.agents/skills`, or `/etc/codex/skills` before the run begins.

A HITL ChatGPT reviewer is attended: Aboard opens the session, keeps the run's write lease and its terminal, and waits for the same human decision on the pull request that a Claude HITL review waits for. An AFK reviewer runs unattended, and its final message, failure, cancellation, or timeout settles through the same Auto Run contracts as its Claude counterpart.

An `[AI]-chrome` issue additionally requires a Chrome browser backend for the worker Aboard gives it to; as with Claude Code, Auto Run gives it to the implementer. Aboard reads the active Codex configuration (`CODEX_HOME`, else `~/.codex/config.toml`), collects the comma-separated `BROWSER_USE_AVAILABLE_BACKENDS` value declared by any configured tool server whatever its name, and compares it case-insensitively. When `chrome` is present, the launch and every resume carry an explicit instruction to use the Chrome backend. When it is absent, the launch is refused before a terminal exists, with a message that names only the variable and the backends it declares. Ordinary launches never require or mention browser configuration.

A ChatGPT Explore session is an ordinary visible top-level Codex session carrying an exploration task, not a Codex subagent. Codex has no built-in Explore agent, so Aboard delivers the read-only role in the prompt and enforces it with `sandbox_mode="read-only"` and `approval_policy="never"`, which the session cannot escalate. Its report reaches Auto Run through the same completion contract Claude Explore uses. Before the terminal exists, Aboard checks the managed Codex requirements it depends on: `[features] hooks = false` and `allow_managed_hooks_only = true` are reported as policy rather than as a startup timeout, and an `allowed_sandbox_modes` allowlist without `read-only`, or an `allowed_approval_policies` allowlist without `never`, refuses the Explore launch by name.

For `claude`, Interactive, implementer, and reviewer deny `Agent`, `WebSearch`, and `WebFetch` by default. Users may replace or clear those profile denials. Explore uses its platform's read-only policy and does not accept Aboard denials.

Aboard reads this file for every new launch, resume, and reopen. Existing processes keep their current configuration. Invalid JSON, schema versions, platforms, commands, models, efforts, or denial lists block later launches. Unsupported fields are ignored with one warning. Before creating a terminal, the selected platform checks the complete configured command (including wrapper arguments) with its version operation.

Auto Run always adds its Git and GitHub mutation restrictions, through each platform's own enforcement mechanism. Worktree runs also add path restrictions for the user's original checkout. These extension-owned rules cannot be removed through `launch.json`. Aboard does not set an allowed-tool list or permission mode, so normal platform permission configuration remains authoritative.

A worktree run copies the ignored local project configuration each platform reads — `.claude`, `.agents`, `.codex`, and `.abd` — into the run's checkout. Live session state is excluded: Claude's `worktrees` directory and Codex's `sessions`, `history.jsonl`, `log`, `logs`, `cache`, and `tmp` entries. Files already present in the checkout are never overwritten, and the run still refuses to start when git does not ignore a path it would copy.

Difficulty routing is:

| Issue label | Claude model | Claude effort | ChatGPT model | ChatGPT effort |
| :-- | :-- | :-- | :-- | :-- |
| `[AI]-routine-difficulty` | `haiku` | `medium` | `gpt-5.6-luna` | `medium` |
| `[AI]-basic-difficulty` | `sonnet` | `high` | `gpt-5.6-terra` | `high` |
| `[AI]-advanced-difficulty` | `opus` | `medium` | `gpt-5.6` | `medium` |
| `[AI]-expert-difficulty` | `opus` | `high` | `gpt-5.6` | `high` |
| No difficulty label | `opus` | `high` | `gpt-5.6` | `high` |

Each platform routes difficulty through its own policy, so a Claude model name never reaches Codex and a Codex slug never reaches Claude Code.

Model and effort resolve independently. For example, `"model": "by-difficulty"` with `"effort": "max"` routes only the model.

## Other settings

`.abd/settings.json` accepts flat or nested keys, with or without the `aboard.` prefix:

```json
{
  "launch": { "maxInlinePromptChars": 6000 },
  "autoRun": { "branchMode": "single-branch" }
}
```

Precedence is `.vscode/settings.json`, `.abd/settings.json`, then user/profile/default settings. Unknown keys and invalid values are reported in Output → aboard.

| Setting | Default | Purpose |
| :-- | :-- | :-- |
| `aboard.bridge.port` | `4823` | Preferred loopback bridge port. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Spill longer generated prompts to one-use temporary files. |
| `aboard.terminals.closeOnSessionEnd` | `false` | Close the terminal after its agent session ends. |
| `aboard.autoRun.review` | `false` | Run `/issue-review` after implementation. |
| `aboard.autoRun.branchMode` | `per-issue` | Use per-issue pull requests or one cumulative branch. |
| `aboard.autoRun.exploreBeforeImplement` | `false` | Run built-in Explore before each fresh implementer. |
| `aboard.autoRun.issueContextDepth` | `1` | Relation levels of issue context preloaded for each worker. |
| `aboard.autoRun.prompt` | `""` | Persistent guidance frozen into each run. |
| `aboard.autoRun.pauseAfterHitl` | `false` | Pause after accepting a HITL issue. |
| `aboard.autoRun.mergeStrategy` | `squash` | Merge issue and eligible run pull requests with squash, merge, or rebase. |
| `aboard.autoRun.mergeRunPullRequest` | `false` | Automatically merge the final run pull request when safe. |
| `aboard.autoRun.pollSeconds` | `30` | Poll interval while waiting for external action. |
| `aboard.autoRun.discardBehavior` | `record-only` | Choose record-only, local-cleanup, or full-cleanup. |
| `aboard.autoRun.worktree.enabled` | `false` | Run in an isolated checkout. |
| `aboard.autoRun.worktree.root` | Sibling directory | Override the checkout root outside the project. |
| `aboard.autoRun.worktree.keep` | `false` | Keep a drained run checkout. |
| `aboard.autoRun.worktree.setupTimeoutSeconds` | `600` | Limit the scaffolded setup script. |

Auto Run freezes run-specific settings when it starts and restores them during recovery. Launch configuration is never frozen; resumes use the latest valid `launch.json`.
