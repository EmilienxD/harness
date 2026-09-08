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

`platform` is required and selects the agent runtime explicitly. It is not inferred from `command`, because that command may begin with a wrapper, package runner, Windows path, or remote executor. This release supports `claude`; a missing or unknown platform blocks launches with a diagnostic that names the field to fix.

The remaining fields are validated by the selected platform. For `claude`, `command` is a non-empty array containing the executable followed by wrapper arguments, and Aboard appends Claude Code's launch flags. `model` accepts `haiku`, `sonnet`, or `opus`; Interactive and Explore also accept `inherit`, while implementer and reviewer accept `by-difficulty`. `effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`, with the same profile-specific `inherit` and `by-difficulty` values. Models or effort values belonging to another platform are rejected before a terminal is created.

Interactive, implementer, and reviewer deny `Agent`, `WebSearch`, and `WebFetch` by default. Users may replace or clear those profile denials. Explore uses Claude Code's built-in policy and does not accept Aboard denials.

Aboard reads this file for every new launch, resume, and reopen. Existing processes keep their current configuration. Invalid JSON, schema versions, platforms, commands, models, efforts, or denial lists block later launches. Unsupported fields are ignored with one warning. Before creating a terminal, the selected platform checks the complete configured command (including wrapper arguments) with its version operation.

Auto Run always adds its Git and GitHub mutation restrictions. Worktree runs also add path restrictions for the user's original checkout. These extension-owned rules cannot be removed through `launch.json`. Aboard does not set an allowed-tool list or permission mode, so normal Claude Code permission configuration remains authoritative.

Difficulty routing is:

| Issue label | Model | Effort |
| :-- | :-- | :-- |
| `[AI]-routine-difficulty` | `haiku` | `medium` |
| `[AI]-basic-difficulty` | `sonnet` | `high` |
| `[AI]-advanced-difficulty` | `opus` | `medium` |
| `[AI]-expert-difficulty` | `opus` | `high` |
| No difficulty label | `opus` | `high` |

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
| `aboard.autoRun.review` | `false` | Run `/review-afk` or `/review-hitl` after implementation. |
| `aboard.autoRun.branchMode` | `per-issue` | Use per-issue pull requests or one cumulative branch. |
| `aboard.autoRun.exploreBeforeImplement` | `false` | Run built-in Explore before each fresh implementer. |
| `aboard.autoRun.recursiveIssueReferences` | `false` | Follow references beyond the primary issue's direct references. |
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
