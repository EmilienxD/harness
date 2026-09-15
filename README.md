# Harness

Harness is a catalogue and installer for small, independently selectable agent skills, hooks, command-line tools, and the optional Aboard VS Code extension. It supports Claude Code and ChatGPT without making you adopt an all-or-nothing workflow.

The project is built around deliberate control. Most skills run only when you invoke them. Hooks act at narrow, visible lifecycle boundaries, with editable policies where configuration is needed. Aboard keeps delegated and automated work in visible terminals that you can inspect, stop, and resume.

## Installation

Run a pinned revision of the ephemeral installer:

```bash
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness
```

The interactive catalogue asks for Claude Code and/or ChatGPT, project or user scope, and the packages you want. Rerun it to add, upgrade, or remove selections. Existing selections start checked, dependencies are handled automatically, user-edited starter files are preserved, and the final plan is shown before anything changes.

For scripts and agents, use the non-interactive commands:

```bash
# Add packages without changing other selections
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness install commit issue-writers

# Preview a ChatGPT-only install
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness install command-guard \
  --platform chatgpt --dry-run --json

# Inspect, upgrade, or remove packages
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness list
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness info subagents
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness upgrade
uvx --from "git+https://github.com/EmilienxD/harness@<commit-or-tag>" harness uninstall commit
```

Commands default to project scope in the current directory and both platforms. Use `--scope user`, `--root <path>`, or repeat `--platform` to narrow the target. Every mutating command supports `--dry-run`; every installer command supports `--json`. Run `harness --help` for the complete CLI.

## Reference

Claude Code invokes a skill as `/skill-name`; ChatGPT uses `$skill-name`. The exceptions are hook-backed commands such as `/commit`, whose prompt is intercepted before a model call.

**User-invoked** skills run only when you explicitly ask for them. **Model-invoked** skills may also be selected automatically when their description fits the work. Harness strongly favors the first group: you decide when a workflow starts, when a draft is published, and when another agent is launched.

### User-invoked skills

- **`resolving-merge-conflicts`**: Resolves an in-progress Git merge or rebase by tracing the intent behind each side, preserving both where possible, running the repository's checks, and finishing the operation. It never aborts the merge or invents unrelated behavior.

- **`setup-git-worktree-maker`**: Creates or updates a repository-native command for making fully initialized Git worktrees. It derives the script, copied local files, setup sequence, command alias, and optional VS Code task from the project, validates the generated command without creating a worktree, and leaves execution to you.

- **`audit`**: Performs a read-only general, security, architecture, quality, performance, reliability, testing, dependency, or privacy audit of a codebase or selected path. Findings include file-and-line evidence, severity, confidence, remediation difficulty, and a recommended order of work; larger scopes can be partitioned across explorer agents.

- **`breakdown-help-wanted-issue`**: Investigates a vague request against the codebase, challenges its scope, and returns a report for your approval. With no supplied request, it can use the oldest open `[AI]-help-wanted` GitHub issue. It does not implement or publish anything.

- **`prototype`**: Builds a throwaway logic or UI prototype in a separate workspace to answer one explicit design question. It keeps prototype code and dependencies outside the repository, exercises only the decisive paths, and reports what the result supports and where its evidence stops.

- **`read-all-adrs`**: Reads every Markdown ADR under `docs/adr/` from start to finish so the current work is informed by the project's recorded architectural decisions.

- **`websearch`**: Researches a question using relevant web and documentation sources, then returns a concise, cited synthesis in chat. It maintains a user-editable index of trusted sources while leaving the rest of the workspace unchanged.

- **`issue-writers`**: Provides `draft-issue`, `draft-issues`, `draft-audit-issues`, `to-spec`, and `to-spec-draft-issue`, followed by the explicit `publish-issues` step. Drafts remain editable local Markdown until you publish them; the publishing hook creates GitHub issues, resolves batch dependencies and parent links, and avoids another model call. Claude Code also gets `copy-message-as-issue` for publishing the latest reviewed response.

- **`issue-readers`**: Installs `address-this` and `review-this`, plus hooks that prepare bounded issue or commit context. Their user-owned starter bodies describe implementation, review, and validation without assuming commit policy; callers such as Aboard add the completion contract for each turn.

- **`commit`**: `/commit <message>` stages the files changed by the current session and commits them without another model call. Add `--dry` to preview or `--ai` to generate a message through a direct Gemini request. Everything except `--ai` is local and needs no API key.

- **`todo-hitl`**: `mark-as-todo-hitl` leaves a focused `TODO(HITL)` for work that needs a human decision; `address-todo-hitl` investigates the highest-priority marker, agrees on a resolution with you, and then implements it.

- **`command-aliases`**: Adds or updates shell aliases in PowerShell, Bash, or Zsh while preserving existing configuration.

- **`text-replacements`**: Adds or updates system-wide AutoHotkey text replacements and reloads the startup script. Windows only.

- **`agent-launcher`**: Installs `cch` and `cxh`, project-configurable wrappers for launching Claude Code and ChatGPT/Codex. A starter `.harness/agent-launcher/` configuration can add a Claude system prompt, provider settings, and standard-library Python extensions; the Claude-only `extend-claude-system-prompt` skill helps maintain and validate that prompt.

- **`decisions`**: Reviews decisions already made during the current conversation and reports only important choices that remain low-confidence, together with the strongest alternative. If no meaningful uncertainty remains, it says so.

- **`next-decision`**: Works through a plan's unresolved choices one at a time. Each round presents the most important ready decision, four viable options, and a recommendation, then waits for your choice before updating the plan and continuing.

- **`stop-overthinking`**: Cuts a stalled discussion down to a practical go/no-go answer, calling out only serious issues and giving concise next steps.

- **`setup-help`**: Guides any installation or configuration one verified step at a time. Every response gives the current action and a short view of what remains, keeping the complete setup checklist synchronized as new prerequisites appear.

- **`subagents`**: Launches separate, visible Claude Code or ChatGPT sessions through `ask-agent` and the Explore, Prototype, Web Search, Brainstorm, Implement, and Review variants. `reply-to-agent` explicitly returns an interactive child's result. The package includes its persistent runtime and hooks; those internal pieces are not separate catalogue choices.

The `subagents` package also installs persistent session commands. These are separate from the ephemeral installer commands above:

```bash
harness run --provider claude|chatgpt [initial prompt]
harness ask <grant-id>
harness reply
harness resume <session-id>
```

`run` opens an independent visible terminal. Delegation is authorized only by a live invocation of an `ask-agent` skill; direct `harness ask` calls without that grant are rejected. Launch settings come from `.harness/launch.json`, then the user-level file, then built-in defaults. Version 3 configures both `providers.claude` and `providers.chatgpt`; `autoRun.provider` defaults to Claude and does not limit explicit `harness run --provider ...` launches. The optional provider-neutral `session.stopWaitHours` controls how long a parent Stop hook waits for an outstanding reply.

### Model-invoked skills

- **`tdd`**: Applies behavior-focused test-driven development in vertical red-green slices. It agrees on public test seams first, rejects implementation-coupled or tautological tests, and adds only enough implementation to satisfy one failing test at a time.

- **`writing-for-agents`**: Guides the creation of predictable skills and agent instruction files. It treats invocation pointers, information hierarchy, completion criteria, progressive disclosure, leading words, and pruning as concrete controls over agent behavior and document load.

- **`writing-adrs`**: Writes architectural decision records as durable contracts. It records only settled decisions, binding values, terse rules, accepted trade-offs, and ADR cross-references in a strict, refactor-resistant format.

- **`report-gotchas`**: Near the end of complicated implementation work, records meaningful caveats, failed checks, unfinished work, or required human action in a configured Discord channel. It does nothing when there is nothing noteworthy to report. Configure its webhook with `harness-report-gotchas configure`.

### Hooks

Hooks do not need a skill invocation. Select them in the catalogue and restart the target product so it reloads its configuration.

| Package | Platforms | What it does |
| --- | --- | --- |
| `command-guard` | Claude Code, ChatGPT | Denies shell commands matching an editable dangerous-command policy. It is a guardrail, not a security sandbox. |
| `no-new-documents` | Claude Code, ChatGPT | Prevents agents from creating files in configured documentation directories while allowing edits to existing files. |
| `on-read-reminder` | Claude Code | Reminds the agent to read required guidance when it reads paths matching configured patterns. |
| `on-edit-reminder` | Claude Code | Lets a matching edit land, then requires the relevant guidance to be read and violations corrected. |
| `on-edit-block` | Claude Code | Denies a matching edit until the required guidance has been read in the current session. |
| `prefer-read-tool` | Claude Code | Nudges the agent toward the reviewable Read tool after shell-based file reads. |
| `prefer-edit-tool` | Claude Code | Nudges the agent toward Write/Edit after shell-based file changes. |
| `prefer-fewer-comments` | Claude Code, ChatGPT | Flags newly written comments or docstrings that exceed an editable budget. |
| `redirect-subagents` | Claude Code | Redirects built-in Agent tool work to configured alternate providers and returns the result to the parent session. |
| `usage-limit-wait` | Claude Code, ChatGPT | Pauses at an exhausted subscription window and resumes after reset; usage-reader failures always fail open. |

## Aboard

Aboard is the optional VS Code extension for visible Claude Code and ChatGPT sessions, fleet tracking, and user-controlled Auto Run workflows. Select `aboard` in Harness to install its verified VSIX and required worker assets.

See the [Aboard README](apps/aboard/README.md) for its visual workflow guide, configuration, and development commands.

## Development

For the Python installer and catalogue:

```bash
uv sync
uv run pytest
uv run harness --help
```

The shared deterministic E2E core uses the real Claude Code or ChatGPT CLI and replaces only model inference with an authenticated loopback endpoint. Tool journeys live under `tests/e2e/`; Aboard-specific journeys stay under `apps/aboard/test/e2e/`.

```bash
cd tests/e2e
npm install
npm run check
npm test
```
