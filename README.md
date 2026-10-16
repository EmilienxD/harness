![Harness Banner](assets/harness_banner.png)

# Harness

Harness is a catalogue and installer for small, independently selectable agent skills, hooks, command-line tools, and the optional Aboard VS Code extension. It supports Claude Code and ChatGPT without making you adopt an all-or-nothing workflow.

Pi supports 24 shared skill packages and Web Toolkit with its CLI and two native web tools, plus native
extensions for path guards, comment budgets, document drafts, issue workflows, Git cleanup,
cloud interviews, session commits, desktop notifications, and Discord gotcha reports.
The [architecture and initial tool scope](docs/PI-ARCHITECTURE.md) track
shipped skills and the remaining extension and runtime ports.

The project is built around deliberate control. Most skills run only when you invoke them. Hooks act at narrow, visible lifecycle boundaries, with editable policies where configuration is needed. Aboard keeps delegated and automated work in visible terminals that you can inspect, stop, and resume.

## Installation

Run the latest version of the ephemeral installer:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

The interactive catalogue asks for Claude Code, ChatGPT, and/or Pi, project or user scope, and the packages you want. Rerun it to add, upgrade, or remove selections. Existing selections start checked, dependencies are handled automatically, user-edited starter files are preserved, and the final plan is shown before anything changes. Removing a selection retains reusable dependencies as independent selections; dependencies declared as coupled components are removed when nothing else requires them. When a package would land on a file Harness does not own, the installer lists those files and asks whether to overwrite them or abandon the installation; approved files become Harness-owned and are removed again on uninstall. A machine-level product a package installs — a `uv` tool or a VS Code extension — gets the same treatment: if one is already present and no Harness receipt accounts for it, the installer names it and asks whether to take ownership, which replaces it with the pinned version and removes it again on uninstall.

When selected packages include skills for Claude Code, the catalogue asks whether to copy the skills or install them in `.agents/skills` and symlink each `.claude/skills/<name>` directory to its counterpart. Copy is the default for a new installation; later runs remember the chosen mode. Non-interactive `install` and `upgrade` accept `--skill-mode copy|symlink` to choose or change it. Hooks and other platform-specific files still use their own provider directories.

In a Git repository, symlink mode depends on Git and the operating system recreating directory symlinks when a clone or worktree is checked out. On Windows, set `git config --global core.symlinks true` and enable symlink creation before creating worktrees. If symlink checkout is disabled, Git writes each link target as a plain text file. Harness warns when project symlink mode is selected in a Git worktree. Use copy mode when the committed project files must work without symlink support.

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

Commands default to project scope in the current directory and Claude Code plus ChatGPT. Select `--platform pi` explicitly for Pi-supported packages. Use `--scope user`, `--root <path>`, or repeat `--platform` to narrow the target. Every mutating command supports `--dry-run`; every installer command supports `--json`. `install` and `upgrade` fail rather than replace files Harness does not own; rerun them with `--overwrite` to take those files over, and with `--adopt` to take over host products installed outside Harness. Run `harness --help` for the complete CLI.

Pi-compatible shared packages are `tdd`, `resolving-merge-conflicts`,
`setup-git-worktree-maker`, `audit`, `grill-me`, `breakdown-help-wanted-issue`,
`read-all-adrs`, `writing-adrs`, `writing-for-agents`, `zoom-out`, `prototype`,
`lavish`, `handoff`, `handoff-grilling`, `todo-hitl`, `decisions`, `next-decision`,
`stop-overthinking`, `setup-command-aliases`, and `setup-text-replacements`, plus
`flush-out-useless-tests` and `test-workflows`. For example, run `uv run harness install tdd audit --platform pi`
from this checkout, then invoke `/skill:tdd` or `/skill:audit` in Pi. `todo-hitl` installs
`/skill:mark-as-todo-hitl` and `/skill:address-todo-hitl`.
Project skills live in `.pi/skills`; user skills live in `~/.pi/agent/skills`, or the agent
directory selected by `PI_CODING_AGENT_DIR`. Review project resources before granting Pi trust.
Audit runs in the current session; Pi explorer delegation remains pending. UI prototypes
require available browser tools, Lavish requires `npx` and external browser review, GitHub
lookup requires authenticated `gh`, and text replacements remain Windows-only.

Install Pi issue workflows with `uv run harness install issue-readers issue-writers --platform pi`,
then run `/reload` and approve the installed resources. Use `/skill:address-this 123` or
`/skill:review-this 123` for prepared issue and checkout context. `/address-this` and
`/review-this` are also accepted. Pi fetches every page of issue comments and relationships
at `HARNESS_ISSUE_CONTEXT_DEPTH` (default 1); preparation failures stop before inference.
Use `/skill:draft-issue`, `/skill:draft-issues`, `/skill:to-spec`, or
`/skill:to-spec-draft-issue` for the shared writing workflows. `/publish-issues --dry`
previews the current Pi session's drafts; `/publish-issues` publishes through the existing
locked gateway without a model call. Pi draft identities are separate from Claude and ChatGPT.
Both packages support project and user installation; issue-reader starter bodies remain user-owned.

Install the Pi path guards with:

```powershell
uv run harness install on-read-reminder on-edit-reminder on-edit-block --platform pi
```

Run `/reload` in Pi, approve the project resources, and configure the corresponding
`.harness/guards/*.toml` policies. The empty starters leave the guards inactive until rules
are added. Extensions live in `.pi/extensions`; Python helpers live in `.pi/hooks`.
User installs use the effective Pi agent directory, with policy starters beside the hooks.
Pi guards require uv or Python 3.11+. They cover native reads/edits/writes, including nested
calls, and recognized shell reads; shell mutations need separate controls.

`harness install prefer-fewer-comments --platform pi` adds advisory comment budgets to local
native `write` and `edit`, including nested calls. Its default budgets are active immediately.
It compares immutable contents captured inside Pi's mutation queue, excludes unchanged comment
bodies, and appends feedback after successful writes. Cooldown follows native session ancestry
through reload/resume/tree navigation. Shell writes and competing remote tool replacements require
separate integration. See the [policy and Pi coverage](docs/user/tools/guards/prefer-fewer-comments.md#pi).

## Reference

Claude Code invokes a skill as `/skill-name`; ChatGPT uses `$skill-name`; Pi uses `/skill:skill-name` for its supported skills. Deterministic commands such as `/commit` are consumed by hooks or native Pi commands before a model call.

**User-invoked** skills run only when you explicitly ask for them. **Model-invoked** skills may also be selected automatically when their description fits the work. Harness strongly favors the first group: you decide when a workflow starts, when a draft is published, and when another agent is launched.

### User-invoked skills

- **`ship`**: Leads one GitHub issue from selection through a guarded implementation loop to an open or merged PR. `/ship` selects the oldest actionable triaged issue; explicit issue numbers bypass triage, parents expand to dependency-ordered leaf loops, and a PR URL resumes review work. Installs `subagents`, `test-workflows`, `issue-readers`, and `resolving-merge-conflicts`.

- **`cleanup-git`**: Automatically inventories every local branch and worktree with a bundled read-only script that runs without arguments from the current directory. Supplies a titled **Git cleanup inventory** in compact TOON tables. Checks merge ancestry, protected branches, local and ignored files, locks, submodules, and ongoing Git operations; includes GitHub facts when `gh` is available. The skill contains the cleanup rules and proposes named actions for approval before deletion or worktree removal. On Pi, `/cleanup-git` and `/skill:cleanup-git` prepare the inventory before expanding the native skill.

- **`resolving-merge-conflicts`**: Resolves an in-progress Git merge or rebase by tracing the intent behind each side, preserving both where possible, running the repository's checks, and finishing the operation. It never aborts the merge or invents unrelated behavior.

- **`setup-git-worktree-maker`**: Creates or updates a repository-native command for making fully initialized Git worktrees. It derives the script, copied local files, setup sequence, command alias, and optional VS Code task from the project, validates the generated command without creating a worktree, and leaves execution to you.

- **`audit`**: Performs a read-only general, security, architecture, quality, performance, reliability, testing, dependency, or privacy audit of a codebase or selected path. Findings include file-and-line evidence, severity, confidence, remediation difficulty, and a recommended order of work; larger scopes can be partitioned across explorer agents.

- **`flush-out-useless-tests`**: Runs scoped tests first and audits only passing tests for useless assertions, duplicates, and weak contracts. Inspects up to 35 test files unless you request more, with no per-test limit. Reports scope and recommendations for approval before cleanup, then verifies the remaining audited tests and gives a brief summary. Use `/flush-out-useless-tests [path or module]` in Claude Code or `$flush-out-useless-tests [path or module]` in ChatGPT.

- **`breakdown-help-wanted-issue`**: Explores a request against the codebase and helps you agree on what to build, with questions and concrete recommendations. With no argument, it fetches the oldest open `[AI]-help-wanted` GitHub issue.

- **`grill-me-in-cloud`**: Stress-tests a plan through branching rounds on a persistent hosted board. Hooks or Pi's native extension supply fresh round and asset paths outside the project, upload local explanation images, publish without waiting for answers, and return the session URL. Drafts survive refreshes; only queued answers enter the deterministic prompt. Copy the reviewed prompt, send through Aboard for Claude/ChatGPT, or choose **Send to Pi** for Pi's standalone relay. Pi confirms a persisted user message and recovers delivery after reload without resubmission; `/grill-cloud-stop` disconnects the interview. Pi requires the current hosted app and additive provider migration.

- **`prototype`**: Builds a throwaway logic or UI prototype to answer one explicit design question. It follows user or project instructions; otherwise it requires a clean working tree, creates and switches to a new `proto/<prototype-name>` branch. It exercises only the decisive paths and reports what the result supports and where its evidence stops.

- **`read-all-adrs`**: Reads every Markdown ADR under `docs/adr/` from start to finish so the current work is informed by the project's recorded architectural decisions.

- **`websearch`**: Researches a question using relevant web and documentation sources, then returns a concise, cited synthesis. It maintains a user-editable index of trusted sources while leaving the rest of the workspace unchanged. Supports Claude Code, ChatGPT, and Pi; invoke `/skill:websearch <question>` on Pi. It uses Context7 for library documentation and the agent's default web search and page-fetching tools. Missing web tools are reported as a coverage gap. The project index lives at `.harness/websearch/INDEX.md`; a Pi user-scope installation bundles its fallback index beside the installed skill.

- **`issue-writers`**: Provides `draft-issue`, `draft-issues`, `to-spec`, and `to-spec-draft-issue`, followed by the explicit `publish-issues` step. Drafts remain editable local Markdown until you publish them; the publishing hook (or native Pi command) creates GitHub issues, resolves batch dependencies and parent links, and avoids another model call. Add `--dry` to preview what would be created without touching the tracker. Drafts are flat files in `.harness/issue-drafts/`; a published draft is deleted, an abandoned one is swept after a week of inactivity, and the publishing lock lives outside the repository, so there is no cleanup command to learn and nothing but drafts in your working tree.

- **`issue-readers`**: Installs `address-this` and `review-this`, plus context preparation through hooks or a native Pi extension. Claude/ChatGPT use bounded context; Pi fetches complete paginated issue data and prepares the local review scope. Their user-owned starter bodies describe implementation, review, and validation without assuming commit policy; callers such as Aboard add the completion contract for each turn.

- **`commit`**: `/commit <message>` stages the files changed by the current session and commits them without another model call. Add `--dry` to preview or `--ai` to generate a message through a direct Gemini request. Everything except `--ai` is local and needs no API key. For `--ai`, set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or put `{"version": 1, "commit": {"geminiApiKey": "your-key"}}` in the gitignored `.harness/config.local.json`. The user-level `~/.harness/config.json` (or `$HARNESS_STATE_DIR/config.json`) can hold the same section for every repository. Do not put the key in committed `.harness/config.json`.

  Install for Pi with `uv run harness install commit --platform pi`, then `/reload` and approve the resources. `/commit` and `/skill:commit` run the same native command. Pi records successful native `write`/`edit` and observed shell changes on the active session branch, verifies file contents again before staging, and adds a `Pi-session` trailer. Reload and exact session resume retain attribution; tree navigation uses only active ancestry, and a new or forked session starts with no ownership. It refuses uncertain attribution, preexisting changes in an edited file, conflicting staging on an owned file, and merges. Unrelated staged files stay staged. Failed AI generation preserves the command's staged files; retry with `/commit <message>` while that index remains unchanged. It never falls back to staging every dirty file. Custom tools and arbitrary extension I/O need explicit attribution support; use ordinary Git for changes the extension cannot safely own.

- **`enable-desktop-notification`**: `/enable-desktop-notification` enables desktop notifications for the current Claude Code, Codex, or Pi session without a model call. Each completed turn displays the beginning of the session title (Claude's `aiTitle`, Codex's saved thread name, or Pi's native session name, with the session ID as fallback) and a preview of the final response. The setting survives session resume; other sessions stay off. Add `--disable` to turn it off. Codex also accepts `$enable-desktop-notification`; Pi also accepts `/skill:enable-desktop-notification`. Uses native Windows PowerShell toasts, macOS `osascript`, or Linux `notify-send` (install it if missing); a local desktop notification service and enabled OS notifications are required. Claude/Codex state lives under `~/.harness/desktop-notification/` or `$HARNESS_STATE_DIR/desktop-notification/`. Pi stores its preference in the native session, across tree navigation and reload, and starts new/forked sessions disabled. Pi notifies once at final settlement, after automatic continuations; errors and aborts get explicit status text. Delivery failures leave the turn complete and display a diagnostic. Install with `uv run harness install enable-desktop-notification --platform pi`, then `/reload` and approve the resources.

- **`todo-hitl`**: `mark-as-todo-hitl` leaves a focused `TODO(HITL)` for work that needs a human decision; `address-todo-hitl` investigates the highest-priority marker, agrees on a resolution with you, and then implements it.

- **`setup-command-aliases`**: Adds or updates shell aliases in PowerShell, Bash, or Zsh while preserving existing configuration.

- **`setup-text-replacements`**: Adds or updates system-wide AutoHotkey text replacements and reloads the startup script. Windows only.

- **`agent-launcher`**: Installs `cch` and `cxh` for your user, with launch access enabled per project by `.harness/agent-launcher/config.py`. Both commands refuse to launch without that configuration. They work from project subdirectories, choosing the nearest configuration without searching above the nearest Git root (including worktrees). Install with project scope to create the starter configuration, or run `cch --hns-init` / `cxh --hns-init` at the project root. The configuration can add a Claude system prompt, provider settings, and standard-library Python extensions; the Claude-only `extend-claude-system-prompt` skill helps maintain and validate that prompt. This package is not required for Pi.

- **`decisions`**: Reviews decisions already made during the current conversation and reports only important choices that remain low-confidence, together with the strongest alternative. If no meaningful uncertainty remains, it says so.

- **`next-decision`**: Works through a plan's unresolved choices one at a time. Each round presents the most important ready decision, four viable options, and a recommendation, then waits for your choice before updating the plan and continuing.

- **`stop-overthinking`**: Cuts a stalled discussion down to a practical go/no-go answer, calling out only serious issues and giving concise next steps.

- **`setup-help`**: Guides any installation or configuration one verified step at a time. Every response gives the current action and a short view of what remains, keeping the complete setup checklist synchronized as new prerequisites appear.

- **`subagents`**: Launches separate Claude Code or ChatGPT conversations, using background processes for automatic work and visible terminals for interactive work through `work-with-agent` and the explore, prototype, websearch, brainstorm, address, and review variants. Prototype delegation supports only `interactive` mode; `auto` is rejected. `reply-to-agent` explicitly returns an interactive child's result. `reply-to-agent-with-previous-message` sends its previous assistant response unchanged through the hook, without another model turn. Invoke `/reply-to-agent-with-previous-message` in Claude or `$reply-to-agent-with-previous-message` in Codex. The hook blocks the invocation, shows a delivery status to the user, and reports an error if no previous message or pending parent request exists. The package includes its persistent runtime and hooks; those internal pieces are not separate catalogue choices.

The `subagents` package also installs persistent session commands. These are separate from the ephemeral installer commands above:

```bash
harness run --provider claude|chatgpt [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible terminal. When `subagents-toolkit` is installed for the current provider, the session-start hook assigns one persistent inbox to the saved conversation and supplies its path in context. Natural-language requests such as "run a Claude subagent" can use the toolkit without an explicit launcher skill invocation. Without the toolkit installed, session start adds no inbox instructions. Request files and execution logs live under `~/.harness/runtime/` (`HARNESS_STATE_DIR` overrides `~/.harness`), never in the project. Automatic children run headlessly with native provider permissions; interactive children open visible sessions. `harness watch` follows structured Claude or Codex progress for the one active background session in the current directory; pass a child session ID to select a particular agent from another terminal, or use `agent-i` inside its parent. `--once` prints the progress recorded so far. The `ask` command prints each launched child's watch command. Progress reports observed searches, tool activity, messages, errors, elapsed time, and provider-reported usage; it does not judge research quality. Children receive stable `agent-i` identifiers scoped to the parent. After an Aboard-launched interactive child sends its reply, its hook shows a VS Code link that returns to the exact parent terminal without switching focus automatically. Use `resume-agent` or `harness resume agent-i "next message"` inside the parent to continue a child, preserving its provider, mode, directory, and conversation. A child whose session is still live, such as an idle terminal, normally continues in a fork of its transcript that keeps the same `agent-i` identifier and leaves the original session open. Aboard's `aboard.sessions.interactiveResumeMode` setting can instead use `reuse-terminal` to send the next message into a matching live interactive terminal; the default remains `fork`. Results survive parent shutdown and replay after interrupted delivery. Launch and resume skills load the shared `subagents-toolkit` instruction skill when needed. The session-start hook supplies the assigned inbox again on resume and after compaction.

When the user explicitly requests a particular model for a subagent, its launch request can include `model: <model-id>`. The hardcoded provider-specific model list lives in `subagents-toolkit` and is updated as models are released. Omit `model` otherwise to retain the current task profile and native provider defaults. An explicit model overrides only the profile's model and is preserved when the child resumes, including through Aboard. Requests also accept an independent `effort: none|minimal|low|medium|high|xhigh|max|ultra` override. The runtime silently selects the closest supported effort for the selected model (preferring the lower level on a tie), or omits the flag for models without effort support. The requested effort is preserved on resume, including through Aboard.

When the user explicitly assigns a subagent to another directory or worktree, its launch request can include `root: <directory-path>`. Relative roots resolve from the parent's saved directory; the directory must already exist. Omit `root` to inherit the parent's directory. Resuming the child preserves its root.

When a parent conversation resumes, Harness checks unfinished child executions and reports any whose processes are verifiably dead. The parent can then explicitly continue an interrupted child with `resume-agent` or `harness resume agent-i "next message"`; reopening the parent alone does not restart its children. Continuation requires a recorded provider conversation ID and its saved transcript. If the ID is missing, Harness refuses the continuation.

Launch settings come from `.harness/config.json`, then the user-level file, then built-in defaults. A file containing only `{ "version": 1 }` is valid; add provider sections only for project-specific overrides. Manual delegation profiles live under `providers.<provider>.delegations`, keyed by the registered task name, including project roles. Exploration defaults to Haiku/low for Claude and GPT-5.6 Luna/low for ChatGPT; the other manual profiles inherit native provider settings. `autoRun.provider` defaults to Claude and does not limit explicit `harness run --provider ...` launches. The optional provider-neutral `session.stopWaitHours` controls how long a parent Stop hook waits for an outstanding reply.

#### Adding project subagent roles

A role is a named task with two skills: a user-invoked `<role>-with-agent` launcher and a child skill containing the actual workflow. For example, `security-with-agent` launches task `security`, which invokes `security-audit` in the child conversation. The parent supplies the audit scope; the child skill supplies how to perform it.

1. Install `subagents` in the project. For Claude, skills live under `.claude/skills/`; for ChatGPT/Codex, use `.agents/skills/`. The examples below use `<skills>` for that directory. If you delegate across providers, install the child skill for the selected provider too.
2. Create `.harness/subagent-tasks.yaml` in the project and add the custom task below. For personal roles, use `~/.harness/subagent-tasks.yaml` (`HARNESS_STATE_DIR` overrides `~/.harness`). These optional files contain only custom roles; the installed toolkit supplies the shipped defaults.

   ```yaml
   security:
     launcher: security-with-agent
     skill: security-audit
     modes: [auto, interactive]
     default-mode: auto
   ```

   Task and skill names use lowercase letters, digits, and hyphens. Each launcher is unique and ends with `-with-agent`; each new task requires a child skill. `default-mode` must appear in `modes`. Builtin task names and launchers are reserved; `loop` and `ship` remain internal to the implementation loop. An empty custom registry is `{}`.

3. Create `<skills>/security-with-agent/SKILL.md`:

   ```markdown
   ---
   name: security-with-agent
   description: Launch a separate agent to audit security within a specified scope.
   argument-hint: "[audit scope]"
   disable-model-invocation: true
   ---

   Invoke the `subagents-toolkit` skill if its instructions are not already in
   the current context. Follow its workflow using the conversation inbox
   supplied by the hook and the registered `security` task.

   Give the child the audit scope, relevant project context, constraints,
   and expected output. Its `security-audit` skill supplies the audit workflow.
   ```

   For ChatGPT/Codex, also create `<skills>/security-with-agent/agents/openai.yaml` to keep the launcher user-invoked:

   ```yaml
   policy:
     allow_implicit_invocation: false
   ```

4. Create `<skills>/security-audit/SKILL.md` with the child's workflow:

   ```markdown
   ---
   name: security-audit
   description: Audit a specified scope for security flaws and report evidence.
   ---

   Inspect the requested scope, its trust boundaries, and relevant callers.
   Trace suspected flaws to reachable execution paths before reporting them.
   For each finding, provide severity, file-and-line evidence, the conditions
   needed to exploit it, and a concrete remediation. Keep the audit read-only.
   Finish after accounting for every requested area; report coverage gaps
   and distinguish confirmed findings from unresolved hypotheses.
   ```

5. Invoke `/security-with-agent <scope>` in Claude or `$security-with-agent <scope>` in ChatGPT/Codex. The hook reads the registry, enables the inbox, and accepts `task: security`; the runtime invokes `/security-audit` or `$security-audit` in the child. A missing child skill fails before launch. If your provider has not picked up newly added skills, restart its session.

The toolkit shows the builtin tasks and modes; its managed `builtin-tasks.yaml` companion supplies the full runtime definitions, including child skills. Before falling back to `general`, or when the user names a custom task, the agent reads the custom registries. The hook and runtime combine the same custom definitions with the builtin tasks. They use the nearest `.harness/subagent-tasks.yaml` from the conversation's saved directory upward through the repository root, plus the personal registry. The hook supplies their resolved paths and the structured-write requirement for inbox requests. A project entry replaces the complete personal definition for that custom task; other personal roles remain available. Custom registries are shared across providers. Missing files mean no custom roles; malformed files fail with an error. Registry edits take effect on the next invocation. Resuming a child preserves its existing task, mode, provider, and workflow even if the registry subsequently changes.

Custom roles use Harness's native background or visible-terminal launch path. Aboard continues to handle its shipped tasks; its bridge currently accepts a fixed task list. Keep the project registry and skill pairs in version control. The installer manages the toolkit and leaves custom registries and user-created skill pairs untouched during upgrades and removal. If you previously added roles to the installed toolkit, move those entries into the custom registry and restore the original installed toolkit before upgrading; existing edits still trigger the installer's modified-file protection.

### Model-invoked skills

- **`test-workflows`**: Defines Markdown end-to-end checks, with covered-file hashes that tell agents when a capability needs verification again. Its CLI is described below.

- **`web-toolkit`**: Gives Claude Code, ChatGPT, and Pi local web search and page fetching through the `web-toolkit` CLI. Free, keyless, and safe for many concurrent agents. Described below.

- **`tdd`**: Applies behavior-focused test-driven development in vertical red-green slices. It agrees on public test seams first, rejects implementation-coupled or tautological tests, and adds only enough implementation to satisfy one failing test at a time.

- **`writing-for-agents`**: Guides the creation of predictable skills and agent instruction files. It treats invocation pointers, information hierarchy, completion criteria, progressive disclosure, leading words, and pruning as concrete controls over agent behavior and document load.

- **`writing-adrs`**: Creates architectural decision records and updates existing records in place when agreed decisions change. It records settled decisions, binding values, terse rules, accepted trade-offs, and ADR cross-references in a refactor-resistant format.

- **`report-gotchas`**: Near the end of complicated implementation work, records meaningful caveats, failed checks, unfinished work, or required human action in a configured Discord channel. It does nothing when there is nothing noteworthy to report. Configure its webhook with `harness-report-gotchas configure`. On Pi, install with `harness install report-gotchas --platform pi` and reload/approve the resources. The shared skill uses a native `report_gotchas` tool that binds reports to the actual Pi session and queues delivery asynchronously. Identical Markdown is deduplicated across reload, resume, and tree navigation; forks and new sessions have separate identities. `/report-gotchas-retry` retries queued delivery without inference. Queue acceptance is durable, but does not mean Discord has received the report.

### Hooks

Hooks do not need a skill invocation. Select them in the catalogue and restart the target product so it reloads its configuration.

| Package | Platforms | What it does |
| --- | --- | --- |
| `command-guard` | Claude Code, ChatGPT, Pi | Denies shell commands matching an editable dangerous-command policy. It is a guardrail, not a security sandbox. Pi evaluates native `bash`/`powershell` calls against the same policy. |
| `no-new-documents` | Claude Code, ChatGPT, Pi | Stops agents from creating files in configured documentation directories and has them write a draft for your approval instead. Edits to existing files are allowed. |
| `on-read-reminder` | Claude Code, Pi | Reminds the agent to read required guidance when it reads paths matching configured patterns. |
| `on-edit-reminder` | Claude Code, Pi | Lets a matching edit land, then requires the relevant guidance to be read and violations corrected. |
| `on-edit-block` | Claude Code, Pi | Denies a matching edit until the required guidance has been read or delivered in the current session branch. |
| `prefer-read-tool` | Claude Code | Nudges the agent toward the reviewable Read tool after shell-based file reads. |
| `prefer-edit-tool` | Claude Code | Nudges the agent toward Write/Edit after shell-based file changes. |
| `prefer-fewer-comments` | Claude Code, ChatGPT, Pi | Flags newly written comments or docstrings that exceed an editable budget. Pi wraps native writes/edits with exact mutation snapshots. |
| `mid-prompt-skills` | Claude Code, ChatGPT | Loads skills typed after other prompt text when the provider otherwise leaves them as plain text. |
| `redirect-subagents` | Claude Code | Redirects built-in Agent tool work to configured alternate providers and returns the result to the parent session. |
| `usage-limit-wait` | Claude Code, ChatGPT | Pauses at an exhausted subscription window and resumes after reset; usage-reader failures always fail open. |

`mid-prompt-skills` covers the case where a provider recognizes a skill at the start of a message but leaves a later mention as plain text. On Claude Code, `/skill-name` gets Claude's argument substitutions and searches managed, personal, and project skills plus `.claude/commands/`; already expanded, disabled, non-invocable, and forked skills are skipped. On ChatGPT, later `$skill-name` mentions and the linked form produced by its skill picker load the selected `SKILL.md`; a leading mention stays with the native loader. Bare names search project and user `.agents/skills` plus Codex's local skill roots, while linked selections can reach plugin skills. Mentions inside fenced code blocks are ignored. Claude plugin and `--add-dir` skills remain outside the hook, and the Claude adapter cannot reproduce shell injection or frontmatter controls such as `allowed-tools` and `model`.

When `no-new-documents` blocks a new file such as `docs/arch/plan.md`, it tells the agent to write it to the mirrored draft path `.harness/doc-drafts/docs/arch/plan.md` instead. That folder is git-ignored, and the agent cannot move or copy drafts into place itself. Review the draft, then run `/approve-doc-draft docs/arch/plan.md` to move it into place or `/reject-doc-draft docs/arch/plan.md` to delete it (`$approve-doc-draft` and `$reject-doc-draft` in ChatGPT). Both commands take files or whole directories, list the pending drafts when run without a path, and run without a model call. Approval never overwrites a file that already exists at the target path. On your next message, the agent learns which drafts were approved or rejected and which are still pending. To request changes, just reply with feedback and the agent revises the draft.

On Pi, install with `harness install no-new-documents --platform pi`, then restart or reload Pi.
The same slash commands and their `/skill:` forms run without inference. The extension guards native
`write` and recognized literal shell creations, including nested tool calls. Arbitrary scripts,
third-party mutators, and filesystem access inside other extensions remain outside this guardrail.
Native writes use Pi's path expansion (`@`, `~`, file URLs, Unicode spaces and Windows shell paths).
Protection follows both logical and resolved paths; linked draft directories are rejected.
Project policies use `.harness/guards/no-new-documents.toml`; Pi user policies start at
`<PI_CODING_AGENT_DIR>/hooks/no-new-documents.toml` (default `~/.pi/agent/hooks/`). Home and project
policies also apply. Command outcomes follow the active session branch; pending drafts follow the
current filesystem. Quote paths containing spaces.

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

## Issue delivery with `/ship`

Run `/ship` in Claude Code or `$ship` in ChatGPT. With no argument it selects the oldest open `[AI]-triaged` issue without open blockers or open sub-issues, skipping claimed issues and those needing a decision or help. Pass issue numbers explicitly to direct parallel sessions. A parent expands to leaf issues in dependency order, with one loop and PR per leaf. After each delivery you choose whether to continue; an explicit instruction to process the whole queue also works. Pass a PR URL to pick up review comments on its existing branch/worktree.

The Lead reads full GitHub context through `issue-context`, creates a worktree only through the project's initialized-worktree script, and defines success before implementation. Missing or failing scripts stop delivery with a suggestion to run `setup-git-worktree-maker`. Project instructions supply the target branch (the Lead asks if absent), merge method (squash by default), and test locations (defaults: `tests/unit/` and `tests/workflow/`). The first branch commit contains deliberately failing unit stubs and workflow criteria only. Implementers fill exactly those stubs; `ship-stubs check` provides the structural Python contract check, while other languages need their native discovery/diff check. Each issue's run state (criteria anchor, implementer sessions, prompts, reports, and evidence) lives in `~/.harness/ship/<owner>-<repo>/issue-<n>/`, which `/ship <PR>` resumes from.

Implementers run in visible terminals through initialized Aboard when available or the standalone terminal launcher. Every successful Stop delivers a report automatically, including context usage when measurable, and waits for exact-token Lead feedback or release. Feedback keeps the same conversation. The Lead accepts a report only when every required test and workflow passes with evidence, without rerunning verification. It replaces an implementer when context or feedback limits, repeated failures, or an unconvincing report warrant it. A fresh implementer receives the original prompt, diff, last report, and recorded problems. Only one implementer may be active per worktree. The optional explorer also uses the subagents runtime.

The Lead owns Git/GitHub mutations and workflow confirmation. Loop-only guards deny Git/GitHub mutation, writes into the repository's other checkouts, and workflow edits. Your own sessions in the same worktree stay unrestricted. These command/path hooks are guardrails, not an operating-system sandbox. Steering is included in reports; interrupts pause delivery. A killed waiting hook invalidates its token, so stale feedback is rejected. Waiting uses `session.stopWaitHours` (up to 24 hours). A timed-out working implementer keeps its worktree reservation until it reaches Stop or its process exit is confirmed; the Lead waits for it to become inactive before publishing or replacing it. Unknown context skips the context threshold; unvalidated Claude model windows remain unknown. Aboard can resume an idle loop in its existing terminal; an idle standalone terminal must exit before runtime resume, or the Lead can launch a fresh implementer. A later `/ship <PR>` conversation on the same provider takes over a released implementer and receives its reports. On Claude, `ship` sets `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to 100 in its installed settings scope: each implementer report continues the Lead's turn through a Stop hook, and Claude otherwise ends a turn after 8 consecutive continuations.

Before opening a PR the Lead merges the latest target once, requests a confirming round when it brought changes/conflicts, stamps passing workflows, checks stale workflows affected by the diff, and enforces the stub contract. The sync confirmation is outside the feedback cap. PR descriptions explain the change and staging checks and use `Refs #n`, keeping the issue open. `[AI]-auto-merge` permits the Lead to merge; other PRs remain open. The Lead comments with the PR link. Decisions, exhausted caps, and expired waits preserve work in a draft PR with `[AI]-needs-decision` and a precise question. Unrelated blockers become linked `[AI]-help-wanted` issues; in auto-merge mode the Lead delivers the prerequisite first and resumes the original. You verify staging and close the issue yourself.

| Label | Meaning |
| --- | --- |
| `[AI]-triaged` | User-approved eligibility for automatic selection. |
| `[AI]-in-progress` | Claimed; `/ship` keeps it until the issue is closed. |
| `[AI]-needs-decision` | Waiting for your decision, alongside the claim. |
| `[AI]-help-wanted` | A tracked prerequisite needing breakdown or help. |
| `[AI]-auto-merge` | The Lead merges the passing PR. |
| `[AI]-*-difficulty` | Routes a `by-difficulty` implementer profile using existing difficulty mappings. |

Missing labels are created on first use. Labels plus PR timeline references describe issue state from GitHub alone. `[AI]-afk` and `[AI]-hitl` remain Aboard's metadata. `address-this`, `review-this`, Aboard Auto Run, and manual ask/reply keep their existing flows.

Sparse `.harness/config.json` version 1 settings:

```json
{
  "version": 1,
  "providers": {
    "claude": { "delegations": { "loop": { "model": "by-difficulty" } } },
    "chatgpt": { "delegations": { "loop": { "model": "by-difficulty" } } }
  },
  "loop": { "maxFeedback": 3, "maxImplementers": 2, "freshContextPercent": 65 },
  "session": { "stopWaitHours": 24 }
}
```

The `loop` profile accepts `model` and `effort`; omitted values inherit provider settings, and `by-difficulty` selects the existing model/effort mapping. Implementers use the Lead's provider and the worktree's configuration. Target and merge method belong in project instructions, not this configuration. Runtime commands are `harness loop launch --cwd <worktree> --prompt-file <file>`, `lookup <session>`, `feedback <session> --wait-token <token> --file <file>`, `release <session> --wait-token <token>`, and `resume <session> --file <file>`. `launch` accepts `--parent <Lead-id>` when not already inside the registered Lead environment.

## Test workflows

Store one Markdown file per capability in the project's workflow folder, default `tests/workflow/`. Use the test title as its filename. Put the check and its coverage patterns in `tests/workflow/greeting.md`:

```markdown
---
covers: ["src/greeting/**/*.py"]
---
## Preconditions
- The application is running with its development configuration.
## Steps
- Open the greeting page and submit a name.
## Acceptance Criteria
- [ ] The page displays the personalized greeting.
## Potential Problems
- An empty name produces a broken or misleading greeting.
```

Run the workflow, then `test-workflows confirm tests/workflow/greeting.md` to automatically create or update the sibling `greeting.manifest.json` with the normalized covered-file hash and generated `verified_files` inventory. Commit both files. Agents write and read the Markdown, including its `covers` patterns; the CLI manages the manifest. A workflow without a manifest is unconfirmed (`stale`). Hashes normalize line endings, so equivalent Windows and Unix checkouts agree. `test-workflows status` reports workflow states and changed covered files in TOON format, including broken mappings whose globs match nothing and malformed workflows or manifests. Add `--json` before or after the command to output JSON instead; this also applies to confirmation and command errors. Exit codes are 0 for all passing, 1 for a stale/broken/invalid workflow, and 2 for a command error. Discovery finds tracked/non-ignored Markdown with `covers` front matter; use `--directory <folder>` or `--root <checkout>` before the subcommand to narrow it.

Run `test-workflows status` explicitly when verifying changes, as you would run unit tests, then run the affected checks and confirm passing ones. Loop implementers run and report; only the Lead stamps their results. Pi installs the same CLI and shared skill; invoke `/skill:test-workflows` to load it explicitly. Confirmation records verification performed by the agent; it does not execute the acceptance steps.

## Background shell

`background-shell` is a Pi-only tool that extends the existing `bash` and Windows
`powershell` tools with `run_in_background`. Install it into another project from this checkout:

```powershell
uv run harness install background-shell --platform pi --root C:\Projects\YourProject
```

For all your projects, use `--scope user` instead of `--root`. Restart Pi or run `/reload`.
The installer places one extension in the selected Pi configuration; it leaves agent instructions
and settings unchanged. No npm package, tmux, WSL, or PowerShell 7 installation is required.
Bash uses Pi's configured Bash executable and command prefix. PowerShell uses Pi's native
Windows shell resolver, including Windows PowerShell when PowerShell 7 is unavailable.

Ask Pi: "Run the test suite in the background, continue the review, and inspect the result
when it finishes." The shell tool itself exposes the option and its usage guidance.
Commands start in the foreground unless `run_in_background: true` requests an immediate job
receipt. If a foreground command exceeds `timeout` (120 seconds by default), the same process
continues in the background without restarting. Its result includes the job ID, temporary log
path, and recent output. Completion delivers the actual exit status, elapsed time, and recent
output and wakes an idle agent. Quiet commands keep running.

Starting with **2.0.0**, foreground `timeout` is a wait limit, not a termination deadline.
Use `execution_timeout` for an optional hard deadline in seconds measured from launch; it
continues counting after automatic backgrounding and terminates the process tree when reached.
For explicitly backgrounded commands, `timeout` retains its hard-deadline behavior and has no
default. If both hard deadlines are supplied, the earlier one wins. For example, `timeout: 5,
execution_timeout: 600` waits up to five seconds in the foreground and permits ten minutes
of total execution. Cancellation before handoff stops the command; after handoff, use
`shell_job` to cancel it.
The optional Windows `powershell` tool follows your existing tool selection; installing this
package does not switch Bash commands to PowerShell syntax.

`shell_job` lists jobs, reads status or recent output, and cancels a job with its process tree.
It retains the last 8 KiB of decoded output and the first 16 MiB in a private temporary log,
with truncation reported explicitly. At most eight shell commands run concurrently (including
commands waiting in the foreground), and 64 background job receipts
are retained. Running jobs and their logs belong to the live Pi session: reload, session changes,
tree navigation, and graceful shutdown cancel them and clear the logs. They do not survive a
Pi restart. Keep Pi open to receive completion notifications.

The existing command guard still checks `bash` and `powershell` before launch, including nested
calls. A background launch result is a job receipt; hooks that infer completed filesystem work
from a shell tool's immediate result cannot use that receipt as evidence of a finished mutation.
Use native edit/write tools for work requiring those outcome-based guards or attribution.
Install one owner of each shell tool; other extensions that replace Bash or PowerShell can conflict.

## Web toolkit

`web-toolkit search "<query>"` prints up to 10 result titles, URLs, and snippets; `site:` and `-site:` operators in the query are enforced as domain filters. `web-toolkit fetch <url>` prints a page as Markdown, a PDF as per-page text, and other text formats unchanged. Pages over 10,000 characters print their beginning and an outline of later headings with line numbers, and save the full text under `~/.harness/web-toolkit/pages/` for the agent to read or grep; saved pages are removed after a day. Neither command takes options.

Fetch tries plain HTTP with a browser-like fingerprint first. Bot challenges, blocked responses, pages with little text or an empty application root, and every search use one shared headless Chrome: the first command that needs it starts it with a dedicated profile, concurrent commands each work in their own tab, and it closes after 10 idle minutes. Search reads public engine result pages, trying DuckDuckGo, Startpage, Bing, and Google in that order and answering from the first engine whose results match the query. An installed Google Chrome or Microsoft Edge is required (or Chromium; set `WEB_TOOLKIT_BROWSER` to choose an executable). The browser state lives in `~/.harness/web-toolkit/` (or `$HARNESS_STATE_DIR/web-toolkit/`). Chrome runs without its own process sandbox, which cannot start inside agent sandboxes.

Installation adds the CLI. Claude Code and ChatGPT receive the fallback skill for when native web tools are unavailable. Pi receives only the native `web_search` and `web_fetch` tools, without the fallback skill; restart Pi or reload extensions after installation. `web_search` takes one required string, `query`; `web_fetch` takes one required string, `url`. Both return `{ output: string, exitCode: integer }`, where `output` is the CLI text followed by any stderr. Nonzero exits are tool errors and preserve HTTP error pages. Calls have a 120-second deadline, a 256 KiB output limit, and support cancellation. The extension invokes the CLI directly with literal arguments and uses the current Pi working directory. It requires `web-toolkit` on Pi's PATH and works at project or user scope.

Pi's `web_search` also accepts optional `allowed_domains` and `blocked_domains` arrays, for example `{ "query": "asyncio TaskGroup", "allowed_domains": ["docs.python.org"], "blocked_domains": ["legacy.docs.python.org"] }`. Use bare domain names rather than URLs. Allowed domains match as alternatives, both filters include subdomains, and exclusions win. Empty arrays apply no restriction. Put website filters in these parameters when using them; combining them with inline `site:` operators is rejected to avoid conflicting restrictions. The CLI continues to accept its existing `site:` query syntax.

The native descriptions explain when to search, fetching sources before relying on excerpts, current-date queries, Markdown source citations, and treating retrieved content as untrusted data. Fetch returns document text for the calling agent to analyze, follows redirects, and supports explicit HTTP and private-network URLs. It uses a dedicated browser profile rather than the user's normal browser login; prefer an authenticated service tool or CLI for content requiring sign-in. Long-page files are saved extracted text, not a fetch-response cache.

A missing CLI returns a direct, pinned `uv tool install --force` command. Both native tools instruct the agent to attempt installation at most once per session. If that command fails, cannot run, or leaves the tools unavailable, the agent must treat both tools as unusable for the rest of the session, stop tool and installation retries, and report the limitation to the user in one sentence. Installation is an explicit agent action; the web tools themselves remain read-only.

Provider configuration remains user-owned. For ChatGPT sandboxed commands, configure network access and writable roots for uv's tool and Python directories and the browser state if needed; the Windows sandbox may otherwise be unable to reach the CLI installation. Search engines throttle bursts of automated queries; a throttled engine is skipped for that search.

## Aboard

Aboard is the optional VS Code extension for visible Claude Code and ChatGPT sessions, fleet tracking, and user-controlled Auto Run workflows. Select `aboard` in Harness to install its verified VSIX and required worker assets.

See the [Aboard README](apps/aboard/README.md) for its visual workflow guide, configuration, and development commands.

## Hosted Grill-Me board

The deployable TanStack Start application lives in `apps/grill/`; its Supabase migration is under `apps/grill/supabase/migrations/`. Configure the hosted server with:

- `HARNESS_GRILL_URL`: its canonical HTTPS origin, without a trailing slash.
- `HARNESS_GRILL_CODE`: the shared four-digit browser and machine-client code.
- `HARNESS_GRILL_SESSION_SECRET`: a long random value used to sign browser-session cookies.
- `CRON_SECRET`: a separate bearer secret used by the scheduled cleanup route.
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: server-only Supabase credentials.

The grill hook and Aboard's relay read the board from the `grill` section of Harness config files, resolving each field from the first source that sets it:

| Source | Committed | Fields |
| :-- | :-- | :-- |
| `.harness/config.local.json` | No; a project install adds it to `.harness/.gitignore`, and uninstall keeps the entry while the file exists | `url`, `code` |
| `.harness/config.json` | Yes | `url` only; a `code` here is ignored |
| `~/.harness/config.json` (or `$HARNESS_STATE_DIR/config.json`) | No | `url`, `code` |
| `HARNESS_GRILL_URL`, `HARNESS_GRILL_CODE` | No | `url`, `code` |

```json
// .harness/config.json
{ "version": 1, "grill": { "url": "https://grill.example.com" } }
// ~/.harness/config.json or .harness/config.local.json
{ "version": 1, "grill": { "code": "1234" } }
```

Every file needs `"version": 1`. For Aboard's relay, the environment row means the VS Code extension host's variables, not the agent's. The relay resolves the sources when the project initializes or the window reloads. Each initialized project relays on its own, and Aboard passes the environment values to terminals it launches. The included Vercel cron calls the cleanup route daily and authenticates with `CRON_SECRET`. The application tables have RLS enabled with no `anon` or `authenticated` grants, and the `grill-assets` bucket is private.

The access cookie is marked `Secure` whenever the request arrives over HTTPS, so local HTTP development needs no override. From `apps/grill/`, run `npm ci`, `npm run dev`, or `npm run build`.

## Development

### Provider research and reference documentation

Pi is an opt-in target for all 24 shared skill packages, including `caveman` and `setup-help`, the three path guards, comment budgets, document draft approval, Git cleanup inventory, both issue workflows, and the cloud interview extension. Project skills use `.pi/skills`;
user installs use `~/.pi/agent/skills` or the configured `PI_CODING_AGENT_DIR`. Omitted `--platform`
continues to select Claude Code and ChatGPT. Other Pi extensions and persistent runtime are pending.
The [Pi architecture proposal](docs/PI-ARCHITECTURE.md) records the requested 35-package backlog
in priority order: 22 packages primarily reuse shared skills and 13 need native extensions.
It defines provider-owned install roots, receipt ownership, a versioned bridge to existing Python
cores, explicit commands, branch-aware session state, hosted answer delivery, and acceptance gates.
Persistent subagents, `/ship`, and the full Aboard adapter follow the initial tool rollout.

The [Pi compatibility report](docs/PI-COMPATIBILITY.md) supplies catalogue-wide feasibility and
API evidence. [Pi's official references and key extension examples](docs/PI-REFERENCES/README.md)
include 50 mirrored upstream files alongside Claude Code and ChatGPT, refreshed by the daily/manual
documentation workflow. The mirror tracks upstream; supported runtime versions will require
separate verification.

Refresh all provider reference sets locally:

```bash
uv run python scripts/update_references.py docs/CLAUDE-REFERENCES docs/CHATGPT-REFERENCES docs/PI-REFERENCES
```

### Installer and catalogue

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
The custom subagent registry requires `--local` until a release refreshes the
`subagents` runtime Git pin to include this loader.

The `/ship` additions require this local installation until a release updates the
runtime Git pins and publishes the corresponding Aboard VSIX. The existing remote
pins predate the new runtime packages; a regular remote install is not a substitute
for `--local` when trying these unpushed changes:

```powershell
uvx --no-cache --from "$checkout" harness --local "$checkout" install ship cleanup-git --root "C:\path\to\project"
```

The shared deterministic E2E core uses the real Claude Code, ChatGPT, and Pi CLIs and replaces only model inference with an authenticated loopback endpoint. Tool journeys live under `tests/e2e/`; Aboard-specific journeys stay under `apps/aboard/test/e2e/`.

Pi's headless E2E environment is ready for tool implementation. It runs the installed Pi CLI in
JSON and RPC modes against the shared fake OpenAI Responses endpoint, with isolated agent
configuration and project settings. From `tests/e2e/`, run `npm run e2e:pi` for the smoke journeys
or `npm run test:pi` for the Pi acceptance checks. See the [E2E implementation guide](tests/e2e/README.md)
for staging real tool payloads, session control, diagnostics, and cleanup. The first tool journey
uses the real catalogue installation of `flush-out-useless-tests`; persistent runtime
support is still pending.

```bash
cd tests/e2e
npm install
npm run check
npm test
```

`npm run e2e:ship -- [claude|chatgpt|all] [scenario|all]` installs the actual local
packages for both providers, then runs deterministic real Lead/implementer loops on
Claude Code and Codex against the private `EmilienxD/harness-e2e` fixture. The Lead's
decisions are scripted; the CLIs, hooks, guards, runtime and GitHub effects are real.
Scenarios: `feedback` (selection/claim, initialized worktree, failing criteria commit,
feedback on warm context, explicit workflow status, stamping, stub contract, open `Refs #n`
PR), `leaves` (parent expansion in dependency order, one squash-merged PR per leaf),
`decision-resume` (linked `[AI]-help-wanted` blocker, `[AI]-needs-decision` draft, then
`/ship <PR>` resuming the same implementer from a new Lead conversation),
`blocker-auto-merge` (prerequisite delivered and merged first, original resumed and
merged) and `fresh-cap` (feedback cap, one active implementer per worktree, fresh
implementer inputs, implementer cap ending in a draft). Merges land on a per-run
target branch. Each run closes only its own issues/PRs and deletes only its own
branches and labels. It needs GitHub authentication and no other triaged issue in
that shared fixture. Provider CLIs use isolated configuration and an authenticated
local inference endpoint; the terminal bridge exercises the runtime launch path
without requiring a desktop window in test automation.
