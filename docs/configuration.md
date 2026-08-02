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
| `aboard.workers.permissionMode` | `default` | Permission mode for every agent aboard launches, the Manager included. Unattended `afk` work needs `bypass`. Applied per process — a running agent keeps the mode it started with. |
| `aboard.terminals.closeOnSessionEnd` | `false` | Close an agent's terminal when its Claude session ends. Off by default: quitting the session (`exit`, double Ctrl+C) and closing the terminal are separate gestures, so the shell is left for you to reuse. The agent leaves the fleet either way, and the leftover terminal never blocks a relaunch. |
| `aboard.autoRun.review` | `false` | Launch a pr-doctor after each implementation during an auto-run. Automated review stays opt-in; the explicit review action is always available. |
| `aboard.launch.claudeCommand` | `claude` | The command aboard launches. Wrapper arguments come first and aboard's flags are appended unchanged. A path with spaces goes in quotes. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Longest prompt passed inline as a command-line argument. Longer prompts spill to `.aboard/runtime/prompts` and are referenced with `@path`. |
| `aboard.launch.effort` | `inherit` | Reasoning effort (`--effort`) for every session aboard starts or resumes, the Manager included. `inherit` passes no flag, leaving Claude Code's own effort level in charge. Applied per process — a running agent keeps the level it started with. |
| `aboard.bridge.port` | `4823` | Preferred loopback port. If occupied, aboard selects an ephemeral port. |

The full list, with descriptions, is in VS Code Settings under **aboard**.

## Agent tool sets are not settings

Every aboard agent takes its tool set from the `tools:` field of its `.claude/agents/<name>.md` definition — including the Manager. To widen or narrow what an agent may do, edit that file. Launch commands never pass `--tools` alongside `--agent`, because a flag competing with the frontmatter would undermine the write lease that trusts it.

Model and effort are edited in the same place and compose rather than compete: `aboard.launch.effort` sets the session level, and an agent that declares `model: opus` or `effort: high` in its own frontmatter overrides it. Claude Code applies frontmatter `model:`/`effort:` only to *subagents*, not to the main-thread session `--agent` starts, so aboard reads both fields from the definition and passes `--model`/`--effort` on the command line for you — including on a resume, which reads no definition at all. Use the definition to give one agent more or less reasoning than the rest; use the setting for the launches with no definition to read — a `raw` session and the builtin agent types. A level aboard does not recognise is reported in Output → aboard rather than passed through, because Claude Code refuses the whole launch on an unknown one.
