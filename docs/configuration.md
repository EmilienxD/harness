# Configuration

aboard settings (`aboard.*`) are edited in VS Code Settings. They resolve through three layers, highest precedence first:

1. `.vscode/settings.json` — an explicit VS Code workspace or folder value.
2. `.aboard/settings.json` — the project override file, checked in and shared with the team.
3. The user, profile, or default value.

`.aboard/settings.json` is optional and never scaffolded; create it when a project needs its own configuration. Keys may be written flat or nested, with or without the redundant `aboard.` prefix, so all three of these set the same thing:

```json
{
  "aboard.workers.permissionMode": "bypass",
  "launch": { "maxInlinePromptChars": 4000 },
  "aboard": { "timeouts": { "managerPrompt": 45 } }
}
```

Changes apply live. An unknown key or an invalid value is reported in Output → aboard and falls back to the value from the next layer.

## Settings worth knowing

| Setting | Default | What it does |
| :-- | :-- | :-- |
| `aboard.workers.permissionMode` | `default` | Permission mode for agents aboard launches or resumes. `bypass` reaches only unattended workers: a launch you drive or are handed (the Manager, `brainstormer`, an interactive built-in agent, a resumed pr-doctor) carries no permission flag at all, so your own Claude Code configuration applies rather than being overridden. Applied per process — a running agent keeps the mode it started with. |
| `aboard.terminals.closeOnSessionEnd` | `false` | Close an agent's terminal when its Claude session ends. Off by default: quitting the session (`exit`, double Ctrl+C) and closing the terminal are separate gestures, so the shell is left for you to reuse. The agent leaves the fleet either way, and the leftover terminal never blocks a relaunch. |
| `aboard.autoRun.review` | `false` | Launch a pr-doctor after each implementation during an auto-run. Automated review stays opt-in; the explicit review action is always available. |
| `aboard.launch.claudeCommand` | `claude` | The command aboard launches. Wrapper arguments come first and aboard's flags are appended unchanged. A path with spaces goes in quotes. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Longest prompt passed inline as a command-line argument. Longer prompts spill to `.aboard/runtime/prompts` and are referenced with `@path`. |
| `aboard.launch.effort` | `inherit` | Reasoning effort (`--effort`) for every session aboard starts or resumes, the Manager included. `inherit` passes no flag, leaving Claude Code's own effort level in charge. Applied per process — a running agent keeps the level it started with. |
| `aboard.bridge.port` | `4823` | Preferred loopback port. If occupied, aboard selects an ephemeral port. |
| `aboard.manager.roadmapReminderBytes` | `150000` | How many transcript bytes may pass with no roadmap injection before the Manager is reminded of the pending tasks and their ids. Bytes rather than turns, because turn size varies far too much to pace on; the check is a bounded read of the transcript's tail, so it costs the same whether the session is minutes or days old. `0` disables the reminder — the session-start and post-compact briefings still carry the full roadmap. The default targets roughly six to eight reminders across a full Manager context; it has **not** been calibrated against measured Manager transcripts, so treat it as a starting point and lower it if the Manager loses track of task ids between briefings. |

The full list, with descriptions, is in VS Code Settings under **aboard**.

## Agent tool sets are not settings

Every aboard agent takes its tool set from the `tools:` field of its `.aboard/agents/<name>.md` definition — including the Manager. To widen or narrow what an agent may do, edit that file; the change applies to that agent's next launch.

The definitions are deliberately **not** in `.claude/agents/`. A file there is a registered Claude Code subagent type, which every session in the workspace can see and spawn — including a `claude` you start yourself, which would then be able to run aboard's `implementer` outside aboard entirely. aboard keeps them where nothing scans and passes each aboard definition to Claude Code as launch flags instead: the body as `--system-prompt-file`, the `tools:` list as `--tools`. `Explore` is the named built-in exception and launches with `--agent Explore`. `general-purpose` is aboard's name for Claude Code's unmodified default session, so its command includes neither `--agent` nor any system-prompt flag.

Model and effort are edited in the same place and compose rather than compete: `aboard.launch.effort` sets the session level, and an agent that declares `model: opus` or `effort: high` in its own frontmatter overrides it. Nothing in an aboard-defined launch applies frontmatter on its own, so aboard reads both fields from the definition and passes `--model`/`--effort` on the command line for you — including on a resume, which re-passes every flag the launch carried. Use the definition to give one agent more or less reasoning than the rest; use the setting for the built-in agents, which have no aboard definition to read. A level aboard does not recognise is reported in Output → aboard rather than passed through, because Claude Code refuses the whole launch on an unknown one.
