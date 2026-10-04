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

Commands default to project scope in the current directory and both platforms. Use `--scope user`, `--root <path>`, or repeat `--platform` to narrow the target. Every mutating command supports `--dry-run`; every installer command supports `--json`. `install` and `upgrade` fail rather than replace files Harness does not own; rerun them with `--overwrite` to take those files over, and with `--adopt` to take over host products installed outside Harness. Run `harness --help` for the complete CLI.

## Reference

Claude Code invokes a skill as `/skill-name`; ChatGPT uses `$skill-name`. The exceptions are hook-backed commands such as `/commit`, whose prompt is intercepted before a model call.

**User-invoked** skills run only when you explicitly ask for them. **Model-invoked** skills may also be selected automatically when their description fits the work. Harness strongly favors the first group: you decide when a workflow starts, when a draft is published, and when another agent is launched.

### User-invoked skills

- **`ship`**: Leads one GitHub issue from selection through a guarded implementation loop to an open or merged PR. `/ship` selects the oldest actionable triaged issue; explicit issue numbers bypass triage, parents expand to dependency-ordered leaf loops, and a PR URL resumes review work. Installs `subagents`, `test-workflows`, `issue-readers`, and `resolving-merge-conflicts`.

- **`cleanup-git`**: Automatically inventories every local branch and worktree with a bundled read-only script that runs without arguments from the current directory. Supplies a titled **Git cleanup inventory** in compact TOON tables. Checks merge ancestry, protected branches, local and ignored files, locks, submodules, and ongoing Git operations; includes GitHub facts when `gh` is available. The skill contains the cleanup rules and proposes named actions for approval before deletion or worktree removal.

- **`resolving-merge-conflicts`**: Resolves an in-progress Git merge or rebase by tracing the intent behind each side, preserving both where possible, running the repository's checks, and finishing the operation. It never aborts the merge or invents unrelated behavior.

- **`setup-git-worktree-maker`**: Creates or updates a repository-native command for making fully initialized Git worktrees. It derives the script, copied local files, setup sequence, command alias, and optional VS Code task from the project, validates the generated command without creating a worktree, and leaves execution to you.

- **`audit`**: Performs a read-only general, security, architecture, quality, performance, reliability, testing, dependency, or privacy audit of a codebase or selected path. Findings include file-and-line evidence, severity, confidence, remediation difficulty, and a recommended order of work; larger scopes can be partitioned across explorer agents.

- **`flush-out-useless-tests`**: Runs scoped tests first and audits only passing tests for useless assertions, duplicates, and weak contracts. Inspects up to 35 test files unless you request more, with no per-test limit. Reports scope and recommendations for approval before cleanup, then verifies the remaining audited tests and gives a brief summary. Use `/flush-out-useless-tests [path or module]` in Claude Code or `$flush-out-useless-tests [path or module]` in ChatGPT.

- **`breakdown-help-wanted-issue`**: Explores a request against the codebase and helps you agree on what to build, with questions and concrete recommendations. With no argument, it fetches the oldest open `[AI]-help-wanted` GitHub issue.

- **`grill-me-in-cloud`**: Stress-tests a plan through branching rounds on a persistent hosted board. The hook supplies fresh round and asset paths outside the project, uploads local explanation images, publishes without waiting for answers, and returns the session URL. Drafts survive refreshes; only queued answers enter the deterministic prompt. Copy that prompt into any provider session, or let Aboard submit it into the exact session's open terminal; the send completes only once the provider confirms it received the prompt.

- **`prototype`**: Builds a throwaway logic or UI prototype to answer one explicit design question. It follows user or project instructions; otherwise it requires a clean working tree, creates and switches to a new `proto/<prototype-name>` branch. It exercises only the decisive paths and reports what the result supports and where its evidence stops.

- **`read-all-adrs`**: Reads every Markdown ADR under `docs/adr/` from start to finish so the current work is informed by the project's recorded architectural decisions.

- **`websearch`**: Researches a question using relevant web and documentation sources, then returns a concise, cited synthesis. It maintains a user-editable index of trusted sources while leaving the rest of the workspace unchanged.

- **`issue-writers`**: Provides `draft-issue`, `draft-issues`, `to-spec`, and `to-spec-draft-issue`, followed by the explicit `publish-issues` step. Drafts remain editable local Markdown until you publish them; the publishing hook creates GitHub issues, resolves batch dependencies and parent links, and avoids another model call. Add `--dry` to preview what would be created without touching the tracker. Drafts are flat files in `.harness/issue-drafts/`; a published draft is deleted, an abandoned one is swept after a week of inactivity, and the publishing lock lives outside the repository, so there is no cleanup command to learn and nothing but drafts in your working tree.

- **`issue-readers`**: Installs `address-this` and `review-this`, plus a hook that prepares bounded issue or commit context. Their user-owned starter bodies describe implementation, review, and validation without assuming commit policy; callers such as Aboard add the completion contract for each turn.

- **`commit`**: `/commit <message>` stages the files changed by the current session and commits them without another model call. Add `--dry` to preview or `--ai` to generate a message through a direct Gemini request. Everything except `--ai` is local and needs no API key. For `--ai`, set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or put `{"version": 1, "commit": {"geminiApiKey": "your-key"}}` in the gitignored `.harness/config.local.json`. The user-level `~/.harness/config.json` (or `$HARNESS_STATE_DIR/config.json`) can hold the same section for every repository. Do not put the key in committed `.harness/config.json`.

- **`enable-desktop-notification`**: `/enable-desktop-notification` enables desktop notifications for the current Claude Code or Codex session without a model call. Each completed turn displays the beginning of the session title (Claude's `aiTitle` or Codex's saved thread name, with the session ID as fallback) and a preview of the final response. The setting survives session resume; other sessions stay off. Add `--disable` to turn it off. Codex also accepts `$enable-desktop-notification`. Uses native Windows PowerShell toasts, macOS `osascript`, or Linux `notify-send` (install it if missing); a local desktop notification service and enabled OS notifications are required. State lives under `~/.harness/desktop-notification/` or `$HARNESS_STATE_DIR/desktop-notification/`.

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
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible terminal. The first explicit delegation skill invocation enables one persistent inbox for the saved conversation, shared across all task types. Request files and execution logs live under `~/.harness/runtime/` (`HARNESS_STATE_DIR` overrides `~/.harness`), never in the project. Automatic children run headlessly with native provider permissions; interactive children open visible sessions. `harness watch` follows structured Claude or Codex progress for the one active background session in the current directory; pass a child session ID to select a particular agent from another terminal, or use `agent-i` inside its parent. `--once` prints the progress recorded so far. The `ask` command prints each launched child's watch command. Progress reports observed searches, tool activity, messages, errors, elapsed time, and provider-reported usage; it does not judge research quality. Children receive stable `agent-i` identifiers scoped to the parent. After an Aboard-launched interactive child sends its reply, its hook shows a VS Code link that returns to the exact parent terminal without switching focus automatically. Use `resume-agent` or `harness resume agent-i "next message"` inside the parent to continue a child, preserving its provider, mode, directory, and conversation. A child whose session is still live, such as an idle terminal, normally continues in a fork of its transcript that keeps the same `agent-i` identifier and leaves the original session open. Aboard's `aboard.sessions.interactiveResumeMode` setting can instead use `reuse-terminal` to send the next message into a matching live interactive terminal; the default remains `fork`. Results survive parent shutdown and replay after interrupted delivery. Full delegation instructions are reinjected after successful compaction.

When a parent conversation resumes, Harness checks unfinished child executions and reports any whose processes are verifiably dead. The parent can then explicitly continue an interrupted child with `resume-agent` or `harness resume agent-i "next message"`; reopening the parent alone does not restart its children. Continuation requires a recorded provider conversation ID and its saved transcript. If the ID is missing, Harness refuses the continuation.

Launch settings come from `.harness/config.json`, then the user-level file, then built-in defaults. A file containing only `{ "version": 1 }` is valid; add provider sections only for project-specific overrides. Manual delegation profiles live under `providers.<provider>.delegations` with independent `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` keys. Exploration defaults to Haiku/low for Claude and GPT-5.6 Luna/low for ChatGPT; the other manual profiles inherit native provider settings. `autoRun.provider` defaults to Claude and does not limit explicit `harness run --provider ...` launches. The optional provider-neutral `session.stopWaitHours` controls how long a parent Stop hook waits for an outstanding reply.

### Model-invoked skills

- **`test-workflows`**: Defines Markdown end-to-end checks, with covered-file hashes that tell agents when a capability needs verification again. Its CLI and hooks are described below.

- **`tdd`**: Applies behavior-focused test-driven development in vertical red-green slices. It agrees on public test seams first, rejects implementation-coupled or tautological tests, and adds only enough implementation to satisfy one failing test at a time.

- **`writing-for-agents`**: Guides the creation of predictable skills and agent instruction files. It treats invocation pointers, information hierarchy, completion criteria, progressive disclosure, leading words, and pruning as concrete controls over agent behavior and document load.

- **`writing-adrs`**: Creates architectural decision records and updates existing records in place when agreed decisions change. It records settled decisions, binding values, terse rules, accepted trade-offs, and ADR cross-references in a refactor-resistant format.

- **`report-gotchas`**: Near the end of complicated implementation work, records meaningful caveats, failed checks, unfinished work, or required human action in a configured Discord channel. It does nothing when there is nothing noteworthy to report. Configure its webhook with `harness-report-gotchas configure`.

### Hooks

Hooks do not need a skill invocation. Select them in the catalogue and restart the target product so it reloads its configuration.

| Package | Platforms | What it does |
| --- | --- | --- |
| `command-guard` | Claude Code, ChatGPT | Denies shell commands matching an editable dangerous-command policy. It is a guardrail, not a security sandbox. |
| `no-new-documents` | Claude Code, ChatGPT | Stops agents from creating files in configured documentation directories and has them write a draft for your approval instead. Edits to existing files are allowed. |
| `on-read-reminder` | Claude Code | Reminds the agent to read required guidance when it reads paths matching configured patterns. |
| `on-edit-reminder` | Claude Code | Lets a matching edit land, then requires the relevant guidance to be read and violations corrected. |
| `on-edit-block` | Claude Code | Denies a matching edit until the required guidance has been read in the current session. |
| `prefer-read-tool` | Claude Code | Nudges the agent toward the reviewable Read tool after shell-based file reads. |
| `prefer-edit-tool` | Claude Code | Nudges the agent toward Write/Edit after shell-based file changes. |
| `prefer-fewer-comments` | Claude Code, ChatGPT | Flags newly written comments or docstrings that exceed an editable budget. |
| `mid-prompt-skills` | Claude Code, ChatGPT | Loads skills typed after other prompt text when the provider otherwise leaves them as plain text. |
| `redirect-subagents` | Claude Code | Redirects built-in Agent tool work to configured alternate providers and returns the result to the parent session. |
| `usage-limit-wait` | Claude Code, ChatGPT | Pauses at an exhausted subscription window and resumes after reset; usage-reader failures always fail open. |

`mid-prompt-skills` covers the case where a provider recognizes a skill at the start of a message but leaves a later mention as plain text. On Claude Code, `/skill-name` gets Claude's argument substitutions and searches managed, personal, and project skills plus `.claude/commands/`; already expanded, disabled, non-invocable, and forked skills are skipped. On ChatGPT, later `$skill-name` mentions and the linked form produced by its skill picker load the selected `SKILL.md`; a leading mention stays with the native loader. Bare names search project and user `.agents/skills` plus Codex's local skill roots, while linked selections can reach plugin skills. Mentions inside fenced code blocks are ignored. Claude plugin and `--add-dir` skills remain outside the hook, and the Claude adapter cannot reproduce shell injection or frontmatter controls such as `allowed-tools` and `model`.

When `no-new-documents` blocks a new file such as `docs/arch/plan.md`, it tells the agent to write it to the mirrored draft path `.harness/doc-drafts/docs/arch/plan.md` instead. That folder is git-ignored, and the agent cannot move or copy drafts into place itself. Review the draft, then run `/approve-doc-draft docs/arch/plan.md` to move it into place or `/reject-doc-draft docs/arch/plan.md` to delete it (`$approve-doc-draft` and `$reject-doc-draft` in ChatGPT). Both commands take files or whole directories, list the pending drafts when run without a path, and run without a model call. Approval never overwrites a file that already exists at the target path. On your next message, the agent learns which drafts were approved or rejected and which are still pending. To request changes, just reply with feedback and the agent revises the draft.

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

Store one committed Markdown file per capability in the project's workflow folder, default `tests/workflow/`:

```markdown
---
covers: ["src/greeting/**/*.py"]
verified_hash: null
---
## Preconditions
Start the application with its development configuration.
## Steps
Open the greeting page and submit a name.
## Expected results
The page displays the personalized greeting.
## Evidence required
Save a screenshot outside the repository.
```

Run the workflow, then `test-workflows confirm <workflow>` to stamp its normalized covered-file hash and generated `verified_files` inventory. Preserve both fields. Hashes normalize line endings, so equivalent Windows and Unix checkouts agree. `test-workflows status` returns JSON with stale workflows and changed covered files, broken mappings whose globs match nothing, and malformed workflows. Exit codes are 0 for all passing, 1 for a stale/broken/invalid workflow, and 2 for a command error. Discovery follows the format in tracked/non-ignored Markdown; use `--directory <folder>` or `--root <checkout>` before the subcommand to narrow it.

The edit hook notifies once per workflow per session. Outside loops, the Stop hook also detects covered changes made through shell tools and blocks once per user turn while an affected workflow is unconfirmed: run and confirm the workflow or explain why you cannot. Loop implementers run and report; only the Lead stamps their results, and the runtime controls Stop feedback and release.

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

The `/ship` additions require this local installation until a release updates the
runtime Git pins and publishes the corresponding Aboard VSIX. The existing remote
pins predate the new runtime packages; a regular remote install is not a substitute
for `--local` when trying these unpushed changes:

```powershell
uvx --no-cache --from "$checkout" harness --local "$checkout" install ship cleanup-git --root "C:\path\to\project"
```

The shared deterministic E2E core uses the real Claude Code or ChatGPT CLI and replaces only model inference with an authenticated loopback endpoint. Tool journeys live under `tests/e2e/`; Aboard-specific journeys stay under `apps/aboard/test/e2e/`.

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
feedback on warm context, workflow edit notice, stamping, stub contract, open `Refs #n`
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
