![Harness Banner](assets/harness_banner.png)

# Harness

Harness is a catalogue and installer for small, independently selectable agent skills, hooks, command-line tools, and the optional Aboard VS Code extension. It supports Claude Code and ChatGPT without making you adopt an all-or-nothing workflow.

The project is built around deliberate control. Most skills run only when you invoke them. Hooks act at narrow, visible lifecycle boundaries, with editable policies where configuration is needed. Aboard keeps delegated and automated work in visible terminals that you can inspect, stop, and resume.

## Installation

Run the latest version of the ephemeral installer:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

The interactive catalogue asks for Claude Code and/or ChatGPT, project or user scope, and the packages you want. Rerun it to add, upgrade, or remove selections. Existing selections start checked, dependencies are handled automatically, user-edited starter files are preserved, and the final plan is shown before anything changes. Removing a selection retains reusable dependencies as independent selections; dependencies declared as coupled components are removed when nothing else requires them. When a package would land on a file Harness does not own, the installer lists those files and asks whether to overwrite them or abandon the installation; approved files become Harness-owned and are removed again on uninstall. A machine-level product a package installs — a `uv` tool or a VS Code extension — gets the same treatment: if one is already present and no Harness receipt accounts for it, the installer names it and asks whether to take ownership, which replaces it with the pinned version and removes it again on uninstall.

When rerunning the interactive catalogue, optional updates appear in a separate
dot picker with nothing selected. Leave a package unselected there to keep its
installed version. Updates required by a newly selected or updated package are
explained before the final confirmation. Adding or removing selections preserves
other installed packages and their dependencies. In scripts, `install` updates
only explicitly named packages and any required dependencies; `uninstall`
preserves the packages being kept. Use `upgrade` to update all installed selections.

For scripts and agents, use the non-interactive commands:

```bash
# Add packages without changing other selections
uvx --from "git+https://github.com/EmilienxD/harness" harness install commit issue-writers

# Preview a ChatGPT-only install
uvx --from "git+https://github.com/EmilienxD/harness" harness install command-guard \
  --platform chatgpt --dry-run --json

# Inspect, upgrade, or remove packages
uvx --from "git+https://github.com/EmilienxD/harness" harness list
uvx --from "git+https://github.com/EmilienxD/harness" harness info subagents
uvx --from "git+https://github.com/EmilienxD/harness" harness upgrade
uvx --from "git+https://github.com/EmilienxD/harness" harness uninstall commit
```

Commands default to project scope in the current directory and both platforms. Use `--scope user`, `--root <path>`, or repeat `--platform` to narrow the target. Every mutating command supports `--dry-run`; every installer command supports `--json`. `install` and `upgrade` fail rather than replace files Harness does not own; rerun them with `--overwrite` to take those files over, and with `--adopt` to take over host products installed outside Harness. Run `harness --help` for the complete CLI.

## Reference

Claude Code invokes a skill as `/skill-name`; ChatGPT uses `$skill-name`. The exceptions are hook-backed commands such as `/commit`, whose prompt is intercepted before a model call.

**User-invoked** skills run only when you explicitly ask for them. **Model-invoked** skills may also be selected automatically when their description fits the work. Harness strongly favors the first group: you decide when a workflow starts, when a draft is published, and when another agent is launched.

### User-invoked skills

- **`resolving-merge-conflicts`**: Resolves an in-progress Git merge or rebase by tracing the intent behind each side, preserving both where possible, running the repository's checks, and finishing the operation. It never aborts the merge or invents unrelated behavior.

- **`setup-git-worktree-maker`**: Creates or updates a repository-native command for making fully initialized Git worktrees. It derives the script, copied local files, setup sequence, command alias, and optional VS Code task from the project, validates the generated command without creating a worktree, and leaves execution to you.

- **`audit`**: Performs a read-only general, security, architecture, quality, performance, reliability, testing, dependency, or privacy audit of a codebase or selected path. Findings include file-and-line evidence, severity, confidence, remediation difficulty, and a recommended order of work; larger scopes can be partitioned across explorer agents.

- **`breakdown-help-wanted-issue`**: Explores a request against the codebase and helps you agree on what to build, with questions and concrete recommendations. With no argument, it fetches the oldest open `[AI]-help-wanted` GitHub issue.

- **`grill-me-in-cloud`**: Stress-tests a plan through branching rounds in an interactive Lavish board. Each question explains why the decision matters and normally offers four explained proposals, with a recommendation and no preselection. Queue answers with freeform context, then submit all or part of a round; unanswered questions stay open. Rich explanations support tables, SVG, images, and interactive examples. Hooks supply a fresh round-file path outside your project and handle rendering, opening, and waiting. After submission, the agent continues in chat or writes another round; the board stays open for reference. Chat interrupts waiting, and revising an unsubmitted round opens a separate review where unsent answers must be queued again.

- **`prototype`**: Builds a throwaway logic or UI prototype in a separate workspace to answer one explicit design question. It keeps prototype code and dependencies outside the repository, exercises only the decisive paths, and reports what the result supports and where its evidence stops.

- **`read-all-adrs`**: Reads every Markdown ADR under `docs/adr/` from start to finish so the current work is informed by the project's recorded architectural decisions.

- **`websearch`**: Researches a question using relevant web and documentation sources, then returns a concise, cited synthesis. It maintains a user-editable index of trusted sources while leaving the rest of the workspace unchanged.

- **`issue-writers`**: Provides `draft-issue`, `draft-issues`, `to-spec`, and `to-spec-draft-issue`, followed by the explicit `publish-issues` step. Drafts remain editable local Markdown until you publish them; the publishing hook creates GitHub issues, resolves batch dependencies and parent links, and avoids another model call. Add `--dry` to preview what would be created without touching the tracker. Drafts are flat files in `.harness/issue-drafts/`; a published draft is deleted, an abandoned one is swept after a week of inactivity, and the publishing lock lives outside the repository, so there is no cleanup command to learn and nothing but drafts in your working tree.

- **`issue-readers`**: Installs `address-this` and `review-this`, plus a hook that prepares bounded issue or commit context. Their user-owned starter bodies describe implementation, review, and validation without assuming commit policy; callers such as Aboard add the completion contract for each turn.

- **`commit`**: `/commit <message>` stages the files changed by the current session and commits them without another model call. Add `--dry` to preview or `--ai` to generate a message through a direct Gemini request. Everything except `--ai` is local and needs no API key.

- **`todo-hitl`**: `mark-as-todo-hitl` leaves a focused `TODO(HITL)` for work that needs a human decision; `address-todo-hitl` investigates the highest-priority marker, agrees on a resolution with you, and then implements it.

- **`setup-command-aliases`**: Adds or updates shell aliases in PowerShell, Bash, or Zsh while preserving existing configuration.

- **`setup-text-replacements`**: Adds or updates system-wide AutoHotkey text replacements and reloads the startup script. Windows only.

- **`agent-launcher`**: Installs `cch` and `cxh`, project-configurable wrappers for launching Claude Code and ChatGPT/Codex. A starter `.harness/agent-launcher/` configuration can add a Claude system prompt, provider settings, and standard-library Python extensions; the Claude-only `extend-claude-system-prompt` skill helps maintain and validate that prompt.

- **`decisions`**: Reviews decisions already made during the current conversation and reports only important choices that remain low-confidence, together with the strongest alternative. If no meaningful uncertainty remains, it says so.

- **`next-decision`**: Works through a plan's unresolved choices one at a time. Each round presents the most important ready decision, four viable options, and a recommendation, then waits for your choice before updating the plan and continuing.

- **`stop-overthinking`**: Cuts a stalled discussion down to a practical go/no-go answer, calling out only serious issues and giving concise next steps.

- **`setup-help`**: Guides any installation or configuration one verified step at a time. Every response gives the current action and a short view of what remains, keeping the complete setup checklist synchronized as new prerequisites appear.

- **`subagents`**: Launches separate Claude Code or ChatGPT conversations, using background processes for automatic work and visible terminals for interactive work through `work-with-agent` and the explore, prototype, websearch, brainstorm, address, and review variants. Prototype delegation supports only `interactive` mode; `auto` is rejected. `reply-to-agent` explicitly returns an interactive child's result. The package includes its persistent runtime and hooks; those internal pieces are not separate catalogue choices.

The `subagents` package also installs persistent session commands. These are separate from the ephemeral installer commands above:

```bash
harness run --provider claude|chatgpt [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
```

`run` opens an independent visible terminal. The first explicit delegation skill invocation enables one persistent inbox for the saved conversation, shared across all task types. Request files and execution logs live under `~/.harness/runtime/sessions/` (`HARNESS_STATE_DIR` overrides `~/.harness`), never in the project. Automatic children run headlessly with native provider permissions; interactive children open visible sessions. Children receive stable `agent-i` identifiers scoped to the parent. After an Aboard-launched interactive child sends its reply, its hook shows a VS Code link that returns to the exact parent terminal without switching focus automatically. Use `resume-agent` or `harness resume agent-i "next message"` inside the parent to continue a child, preserving its provider, mode, directory, and conversation. A child whose session is still live, such as an idle terminal, normally continues in a fork of its transcript that keeps the same `agent-i` identifier and leaves the original session open. Aboard's `aboard.sessions.interactiveResumeMode` setting can instead use `reuse-terminal` to send the next message into a matching live interactive terminal; the default remains `fork`. Results survive parent shutdown and replay after interrupted delivery. Full delegation instructions are reinjected after successful compaction.

Launch settings come from `.harness/config.json`, then the user-level file, then built-in defaults. A file containing only `{ "version": 1 }` is valid; add provider sections only for project-specific overrides. Manual delegation profiles live under `providers.<provider>.delegations` with independent `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` keys. Exploration defaults to Haiku/low for Claude and GPT-5.6 Luna/low for ChatGPT; the other manual profiles inherit native provider settings. `autoRun.provider` defaults to Claude and does not limit explicit `harness run --provider ...` launches. The optional provider-neutral `session.stopWaitHours` controls how long a parent Stop hook waits for an outstanding reply.

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
| `remove-anthropic-coauthor` | Claude Code | Amends new Git commits to remove `Co-Authored-By: Claude … <noreply@anthropic.com>`, preserving human co-authors. |
| `usage-limit-wait` | Claude Code, ChatGPT | Pauses at an exhausted subscription window and resumes after reset; usage-reader failures always fail open. |

`remove-anthropic-coauthor` runs after successful Bash/PowerShell calls that report a Git commit. It checks that the reported commit is still HEAD, removes matching lines from the final trailer paragraph, and reports the new hash to Claude. The amend preserves the tree, parents, original author, index, and worktree; commit hooks are not rerun, and configured commit signing is honored. Keep commit and push in separate tool calls so the hook can clean the message before it is pushed. Quiet commits or redirected commit output cannot be detected. Repository lookup supports the hook's working directory and literal `cd` or `git -C` paths; shell variables and computed paths are not expanded.

#### Guard configuration

Editable Guard policies are provider-neutral TOML files in `.harness/guards/`. Every file starts with `version = 1`. User-level rules from `~/.harness/guards/` load first and project rules append afterward; `.claude/` and `.codex/` contain only native hook registration and executables.

The read/edit guards share one ordered rule schema and gitignore-style path patterns (`*`, `?`, and `**`):

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/CONVENTIONS.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

`no-new-documents.toml` uses the same path vocabulary:

```toml
version = 1
protected = ["**/docs/**", "project-notes/**"]
```

In `command-guard.toml`, each rule explicitly groups a reason with regular expressions. TOML literal strings are convenient for expressions containing backslashes:

```toml
version = 1

[[rules]]
reason = "network content piped directly into a shell"
patterns = ['''(curl|wget).*\|\s*(ba|z)?sh''']
```

`prefer-fewer-comments.toml` keeps numeric settings under `[limits]` and uses ordered `[[rules]]` with `exempt = true` or `false` for path exemptions. The installed starter files contain editable examples for every field.

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

To try an unpushed checkout against another project, use `--local` before the
installer subcommand (or omit the subcommand for the interactive menu):

```powershell
$checkout = "C:\Users\emb\Desktop\dev\projects\harness"
uvx --no-cache --from "$checkout" harness --local "$checkout" --root "C:\Users\emb\dev\unloopedit"
# Non-interactive installation:
uvx --no-cache --from "$checkout" harness --local "$checkout" install report-gotchas subagents --root "C:\Users\emb\dev\unloopedit"
```

`--local` reads the checkout's catalogue and installs its Python runtime tools
from local directories, including uncommitted changes. Without it, runtime tools
use the GitHub commits pinned in the manifests. `--no-cache` rebuilds the installer
from the current checkout; local runtime installations also bypass the build cache.
Host tools are installed for your user even when the selected scope is Project.
Aboard still uses its published VSIX; see its README for extension development.

The shared deterministic E2E core uses the real Claude Code or ChatGPT CLI and replaces only model inference with an authenticated loopback endpoint. Tool journeys live under `tests/e2e/`; Aboard-specific journeys stay under `apps/aboard/test/e2e/`.

```bash
cd tests/e2e
npm install
npm run check
npm test
```

Run `npm run e2e:remove-anthropic-coauthor` from `tests/e2e/` to verify the attribution-removal hook with the real `claude -p` CLI and the fake Anthropic endpoint. This journey requires the ownership-recorded `EmilienxD/harness-e2e` checkout; set `HARNESS_E2E_FIXTURE_ROOT` to its runtime directory (defaults to `ABOARD_E2E_ROOT`, then `~/dev/harness-e2e-runtime`). It commits in a temporary clone, verifies two model trailers are removed while human co-authors and staged changes survive, and leaves the shared checkout and remote unchanged.
