# Productivity tools

Install a package from the Harness catalogue, or run `harness install <package>` from the project directory. Claude Code invokes a skill as `/skill-name`; ChatGPT uses `$skill-name`. The table lists every active productivity package.

| Package | What to use it for | Availability |
| --- | --- | --- |
| [`agent-launcher`](productivity/agent-launcher.md) | Launch Claude Code with `cch` or Codex with `cxh`, with project settings. | Both; its prompt editing skill is Claude only |
| [`caveman`](productivity/caveman.md) | Ask for a much shorter, compressed answer. | Both |
| [`decisions`](productivity/decisions.md) | Surface consequential choices in the current conversation that remain uncertain. | Both |
| [`handoff`](productivity/handoff.md) | Create a detailed handoff document for another agent. | Both |
| [`handoff-grilling`](productivity/handoff-grilling.md) | Preserve a grilling conversation in a handoff document. | Both |
| [`mid-prompt-skills`](productivity/mid-prompt-skills.md) | Expand skills mentioned after other text in a prompt. | Both |
| [`next-decision`](productivity/next-decision.md) | Resolve a plan's open choices one at a time. | Both |
| [`report-gotchas`](productivity/report-gotchas.md) | Send meaningful remaining implementation caveats to Discord. | Both |
| [`setup-command-aliases`](productivity/setup-command-aliases.md) | Add or change PowerShell, Bash, or Zsh aliases. | Both |
| [`setup-text-replacements`](productivity/setup-text-replacements.md) | Add or change always-on AutoHotkey replacements. | Both; Windows only |
| [`stop-overthinking`](productivity/stop-overthinking.md) | Get a short practical decision when discussion stalls. | Both |
| [`subagents`](productivity/subagents.md) | Delegate work to persistent Claude Code or Codex conversations. | Both |
| [`todo-hitl`](productivity/todo-hitl.md) | Mark code work needing a human decision, then resolve a marker. | Both |
| [`writing-for-agents`](productivity/writing-for-agents.md) | Write clear skills and agent instruction files. | Both |
| [`zoom-out`](productivity/zoom-out.md) | Get a higher-level map of a codebase area. | Both |

## Everyday skills

Invoke `decisions` after a discussion to see only the important low-confidence choices and their strongest alternatives. Use `next-decision` on a plan when you want to choose one issue at a time; it presents options and waits for your answer. `stop-overthinking` gives a concise go/no-go call. `zoom-out` maps a code area before you focus on its details. `caveman` requests compressed communication.

Use `handoff` to capture the current conversation for a new agent, or `handoff-grilling` for a grilling session. `mark-as-todo-hitl` leaves a focused `TODO(HITL)` where human input is needed; `address-todo-hitl` investigates the highest-priority marker, agrees on a resolution with you, and implements it. `writing-for-agents` helps author skills and agent instructions. Invoke `setup-command-aliases` or, on Windows, `setup-text-replacements` to have the agent update the relevant shell or AutoHotkey configuration.

`mid-prompt-skills` expands a skill mention after other prompt text: `/skill-name` in Claude Code and `$skill-name` in ChatGPT. It leaves leading invocations to the provider's native loader and ignores examples in fenced code blocks. Claude searches managed, personal, and project skills plus `.claude/commands/`; ChatGPT searches project and user `.agents/skills` and also follows the linked skill-picker form, including plugin skills.

## Subagents

Choose `work-with-agent` for general delegation, or `explore-with-agent`, `prototype-with-agent`, `websearch-with-agent`, `brainstorm-with-agent`, `address-with-agent`, or `review-with-agent` for a bounded task. Specify `mode: interactive` to work with the child in a visible terminal; the default `auto` mode runs it in the background. Prototype delegation requires interactive mode. An interactive child uses `reply-to-agent` to return its result. Use `resume-agent` to continue an existing child while preserving its provider, mode, directory, and conversation.

The installed persistent commands are distinct from the `harness install` catalogue command:

```text
harness run --provider claude|chatgpt [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible terminal. `ask` processes a parent's delegation inbox. `watch` follows recorded progress for a background child; `--once` prints the progress so far. Within a parent, `agent-i` identifies one child. Runtime requests and logs live under `~/.harness/runtime/`; set `HARNESS_STATE_DIR` to change the Harness state root.

Launch configuration uses the first existing file: project `.harness/config.json`, then user `~/.harness/config.json`, then defaults. The files are **not merged**. A minimal file is `{ "version": 1 }`. For example, a project can choose the automatic provider and override one manual delegation profile:

```json
{
  "version": 1,
  "autoRun": { "provider": "chatgpt" },
  "providers": {
    "chatgpt": {
      "delegations": {
        "explore": { "model": "gpt-5.6-luna", "effort": "low" }
      }
    }
  },
  "session": { "stopWaitHours": 1 }
}
```

`autoRun.provider` defaults to `claude` and does not restrict explicit `harness run --provider` launches. Each provider may set `command` and independent `delegations` profiles for `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general`. Profiles accept `model` and `effort`; `"inherit"` uses native provider settings. Exploration defaults to Haiku/low for Claude and GPT-5.6 Luna/low for ChatGPT; other profiles inherit native settings. Claude profiles other than `explore` can also set `deniedTools`. `session.stopWaitHours` is an optional nonnegative wait time for an outstanding reply. Keep credentials out of this project file.

## Agent launcher

Installing `agent-launcher` installs the `cch` and `cxh` commands. They pass normal command-line arguments through to Claude Code and Codex. From a project, run `cch --hns-init` or `cxh --hns-init` to create missing starter files under `.harness/agent-launcher/`. Both commands find the nearest ancestor's `.harness/agent-launcher/config.py`; without one, they launch the native command with default options.

The starter `config.py` defines `COMMANDS` and returns `LaunchConfiguration` with Claude and ChatGPT `LaunchOptions`. It reads `system-prompt.md` and `claude/settings.json` for Claude, and `chatgpt/config.toml` for Codex. Edit those files for project settings; `config.py` can import standard-library Python modules from `extensions/` to generate Claude prompt context. Check the result with `cch --hns-render`, `cch --hns-render-settings`, or `cxh --hns-render-settings`. The Claude-only `extend-claude-system-prompt` skill maintains that prompt and validates its rendered output. `config.py` is executable Python, so review it before using it in an untrusted project. Store secrets in an appropriate private location rather than a committed project config.

## Report gotchas

`report-gotchas` is a model-invoked skill for meaningful caveats remaining after implementation: failed checks, incomplete verification, unresolved risks, or required human action. It sends nothing when there is nothing new to report. Configure a Discord incoming webhook interactively with `harness-report-gotchas configure`; the command hides terminal input. The webhook is saved in the user-owned `~/.harness/report-gotchas/config.json`, not the project. `HARNESS_REPORT_GOTCHAS_STATE_DIR` changes that state directory, and `HARNESS_REPORT_GOTCHAS_WEBHOOK_URL` supplies the webhook through the environment. Keep the URL private: possession of it permits posting to the channel.

For a manual report, pass Markdown on standard input or use `harness-report-gotchas submit -m "**Task**: concrete issue and consequence."`; `harness-report-gotchas retry` retries queued reports. Reports include session and Git context automatically, so omit secrets and avoid repeating those details in the message.
