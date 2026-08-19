# Configuration

aboard settings (`aboard.*`) are edited in VS Code Settings. They resolve through three layers, highest precedence first:

1. `.vscode/settings.json` — an explicit VS Code workspace or folder value.
2. `.aboard/settings.json` — the project override file, checked in and shared with the team.
3. The user, profile, or default value.

`.aboard/settings.json` is optional and never scaffolded; create it when a project needs its own configuration. Keys may be written flat or nested, with or without the redundant `aboard.` prefix, so all three of these set the same thing:

```json
{
  "launch": { "maxInlinePromptChars": 4000 },
  "aboard": { "timeouts": { "managerPrompt": 45 } }
}
```

Changes apply live. An unknown key or an invalid value is reported in Output → aboard and falls back to the value from the next layer.

## Settings worth knowing

| Setting | Default | What it does |
| :-- | :-- | :-- |
| `aboard.terminals.closeOnSessionEnd` | `false` | Close an agent's terminal when its Claude session ends. Off by default: quitting the session (`exit`, double Ctrl+C) and closing the terminal are separate gestures, so the shell is left for you to reuse. The agent leaves the fleet either way, and the leftover terminal never blocks a relaunch. |
| `aboard.autoRun.review` | `false` | Launch a pr-doctor after each implementation during an auto-run. Automated review stays opt-in; the explicit review action is always available. |
| `aboard.autoRun.mergeRunPullRequest` | `false` | Merge the run's own pull request when the run ends. An auto-run implements each issue on its own branch, merges those into one session branch (`aboard/run/<run id>`), and opens a single pull request from it into the branch you were on when the run started — never into the repository's default branch of its own accord. Off by default: that target is a branch you are working on, a conflict there is likely, and landing a batch of automated work on it is your decision. When on, aboard attempts the merge once, merges the target back in and retries if that resolves the conflict, and otherwise leaves the pull request open and tells you. |
| `aboard.launch.claudeCommand` | `claude` | The command aboard launches. Wrapper arguments come first and aboard's flags are appended unchanged. A path with spaces goes in quotes. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Longest prompt passed inline as a command-line argument. Longer prompts spill to `.aboard/runtime/prompts` and are referenced with `@path`. |
| `aboard.launch.effort` | `inherit` | Reasoning effort (`--effort`) for every session aboard starts or resumes, the Manager included. `inherit` passes no flag, leaving Claude Code's own effort level in charge. Applied per process — a running agent keeps the level it started with. |
| `aboard.bridge.port` | `4823` | Preferred loopback port. If occupied, aboard selects an ephemeral port. |
| `aboard.manager.roadmapReminderBytes` | `150000` | How many transcript bytes may pass with no roadmap injection before the Manager is reminded of the pending tasks and their positions. Bytes rather than turns, because turn size varies far too much to pace on; the check is a bounded read of the transcript's tail, so it costs the same whether the session is minutes or days old. `0` disables the reminder — the session-start and post-compact briefings still carry the full roadmap. The default targets roughly six to eight reminders across a full Manager context; it has **not** been calibrated against measured Manager transcripts, so treat it as a starting point and lower it if the Manager loses track of task positions between briefings. |
| `aboard.manager.transcriptBackups` | `5` | How many Manager session transcripts aboard keeps under `.aboard/runtime/transcripts`. Claude Code deletes its own session files older than `cleanupPeriodDays` every time it starts, the minimum is one day and there is no way to turn the sweep off, so aboard copies the Manager's transcript at each turn boundary and restores it if a resume finds it gone. The copy is incremental — only the bytes the transcript gained — and a restore never overwrites a session Claude Code still has. `0` turns both the backup and the restore off; copies already on disk are left for you to delete. |

The full list, with descriptions, is in VS Code Settings under **aboard**.

## Claude in Chrome

Chrome access is a per-launch choice rather than a persistent setting. Use `/general-purpose --chrome`, set `chrome: true` on `run_agent`, use `/auto --chrome`, set `chrome: true` on `start_auto_run`, or run **Aboard: Start Auto Run with Chrome** from the command palette. The ordinary forms explicitly pass `--no-chrome`; the Chrome forms pass `--chrome`. Auto-run chooses once for the entire run and passes the choice only to implementers, including after recovery. General-purpose fleet restoration likewise replays the session's original choice.

Enabling the integration exposes browser tools and the signed-in Chrome session to Claude. aboard does not auto-approve those tools: your own Claude permissions decide whether calls run or prompt. Missing extensions, unsupported providers, or a disconnected browser remain visible in the Claude terminal rather than silently falling back.

## Agent tool sets are not settings

Every aboard-defined agent takes its capability set from the `tools:` field of its `.aboard/agents/<name>.md` definition — including the Manager. The Manager alone admits `mcp__aboard__*`; non-Manager launches additionally receive that namespace as an infrastructure-level denial because the project-scoped MCP registration is visible to every Claude Code session in the workspace. To widen or narrow an agent's ordinary capabilities, edit its definition; the change applies on its next launch.

The definitions are deliberately **not** in `.claude/agents/`. A file there is a registered Claude Code subagent type, which every session in the workspace can see and spawn — including a `claude` you start yourself, which would then be able to run aboard's `implementer` outside aboard entirely. aboard keeps them where nothing scans and passes each aboard definition to Claude Code as launch flags instead: the body as `--system-prompt-file`, the `tools:` list as `--tools`. `Explore` is the named built-in exception and launches with `--agent Explore`. Its metadata-only `.aboard/agents/Explore.md` profile may set `model:`, `effort:`, and `command:`, but must contain neither `tools:` nor a body: Claude Code remains responsible for the builtin's current prompt and tool set. `general-purpose` is aboard's name for Claude Code's unmodified default session, so its command includes neither `--agent` nor any system-prompt flag.

Model and effort are edited in the same place and compose rather than compete: `aboard.launch.effort` sets the session level, and an agent or the Explore profile that declares `model: opus` or `effort: high` in its own frontmatter overrides it. Nothing in an aboard launch applies that frontmatter on its own, so aboard reads both fields and passes `--model`/`--effort` on the command line for you — including on a resume. Use the per-agent file to give one agent more or less reasoning than the rest; use the setting as the fleet-wide default. A level aboard does not recognise is reported in Output → aboard rather than passed through, because Claude Code refuses the whole launch on an unknown one.
