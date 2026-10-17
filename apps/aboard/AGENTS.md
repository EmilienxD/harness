# AGENTS.md

## Project Shape

Aboard is a strict TypeScript VS Code extension for Claude Code, ChatGPT (Codex CLI), and Pi. It launches
visible agent terminals, tracks fleet and recent activity, manages project scaffold state, exposes a
loopback bridge, and orchestrates issue-driven Auto Run workflows. Harness owns the user-facing skills,
hooks, session commands, and persistent state that Aboard integrates with; Aboard never copies those assets
into its scaffold or private runtime bundle.

The clean-slate redesign has no compatibility layer. Do not restore Manager, roadmap/TODO, MCP, custom
agent definitions, report mailboxes, in-process child telemetry, `/queue`, or standalone PR-review entry
points.

## Repository Layout

- `src/extension.ts`: composition root; activation, dependency wiring, commands, views, and disposal.
- `src/configuration.ts`: VS Code and `.abd/settings.json` setting resolution.
- `src/domain/`: platform-neutral fleet, leases, run plans, Auto Run state, cleanup, contracts, and
  validation. Put product rules here before adapters.
- `src/platform/`: shared agent-platform contracts, launch configuration, launch/runtime primitives,
  prompts, terminals, preflight execution, session reopen, and lifecycle abstractions.
- `src/claude/`: Claude Code configuration parsing, launch planning, preflight policy, lifecycle, sessions,
  and skills.
- `src/chatgpt/`: Codex launch, managed-policy checks, lifecycle, sessions, skills, and browser backend
  detection.
- `src/pi/`: Pi launch/configuration, native lifecycle, session lookup and skill readiness.
- `src/auto/`: Auto Run engine, observation, permissions, worktrees, and terminal cleanup.
- `src/bridge/`: authenticated loopback server, lifecycle routes, worker hooks, delegation, and visible
  command-terminal API.
- `src/runtime/`: admission, persistence, activity recording, layout, counters, and lock markers.
- `src/scaffold/`: `.abd/` initialization, updates, and scaffold ownership.
- `src/git/` and `src/github/`: the only owners of Auto Run Git and GitHub mutation.
- `src/vscode/`: tree views, the Run Agent launcher, commands, native UI, terminals, reviews, and activity
  presentation.
- `assets/scaffold/`: project files installed into `.abd/`.
- `assets/runtime/`: extension-owned runtime assets.
- `test/unit/`: bundled Node unit tests and VS Code integration suite.
- `test/e2e/`: deterministic real-CLI and VS Code journeys; use the `harness-e2e` skill here.
- `scripts/package.ts`: VSIX packaging and verification.

## Session and Runtime Model

- `interactive`: empty, user-controlled Claude Code, Codex, or Pi TUI.
- `explore`: read-only exploration; Claude's built-in Explore agent or a top-level Codex session enforced with
  `sandbox_mode="read-only"` and `approval_policy="never"`, or native Pi read tools enforced by its extension.
- `prototype`, `websearch`, `brainstorm`, and `general`: manual delegation identities. Their explicit
  `interactive` or `auto` execution mode is separate from Auto Run worker semantics.
- `address`: Auto Run worker invoking `/address-this` on Claude or `$address-this` on ChatGPT.
- `review`: Auto Run worker invoking `/review-this` on Claude or `$review-this` on ChatGPT. AFK and
  HITL are orchestration modes, not separate skills.

Headless execution is one-shot: a detached provider process with no terminal, no takeover, and no resume.
It covers `auto` delegations and Auto Run exploration, whose report is read once. Auto Run workers keep an
unfocused visible terminal even in AFK mode, because the user takes them over, continues them, and accepts
their work. `isHeadlessExecution` in `domain/contracts.ts` is the one decision the terminal controller and
all launch adapters ask, so a mode never means headless in one of them and visible in another.

`.abd/scaffold.json` is the initialized-project marker; when absent, runtime surfaces and the command
endpoint are closed. Mutable runtime state belongs in VS Code storage, not the workspace.

`.harness/config.json` is a sparse launch authority and is re-read whenever launch, resume, or reopen
starts a new process. Resuming into an existing terminal retains that process's configuration.
Omitted fields use code-owned defaults. `providers.claude`, `providers.chatgpt`, and `providers.pi` are equal,
independently validated configurations; the provider is explicit rather than inferred from the wrapper-friendly `command` array. **Run Agent** asks which provider to launch,
the Run Agent webview above the fleet edits personal workspace presets, and
`autoRun.provider` selects the Auto Run default and is scaffolded as `claude`. Reopen always uses the
provider recorded by the session, even when the Auto Run default changes. Existing processes retain their
configuration. Interactive, manual-delegation, and Auto Run profiles select model and effort independently.
Manual delegation keys are `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and
`general`; their task identity must survive launch and resume instead of collapsing configuration to the
runtime `general` identity. Profiles may use `inherit`; Auto Run workers may use `by-difficulty`.
Platform-specific values must be validated before a terminal is created.

The launcher webview owns personal preset editing; preset definitions live in profile storage and describe
future launches. Run Agent opens one editor terminal in the current window's active editor group.
Launch layout offers Current window and New window. Both apply the preset grid and start its terminals
in their assigned panes. Current window preserves open editors and terminals while applying the grid;
New window opens the same project and launches once during initialization. Each window manages its own
fleet and terminals. Startup handoffs carry project, owner,
and request identities; use the durable request journal before launch effects and keep uncertain requests
from being replayed. Apply geometry only for an explicit Launch layout request or new-window startup.
After launch, user rearrangements remain authoritative; Run Agent adds one tab without applying a grid.
Visible delegations open as a tab in their live parent terminal's group. VS Code exposes no
terminal-to-tab mapping, so `terminalPane` reveals the parent and observes the group VS Code activates.

Difficulty routing:

| Issue label | Claude | ChatGPT |
| :-- | :-- | :-- |
| `[AI]-routine-difficulty` | `haiku`, medium | `gpt-5.6-luna`, medium |
| `[AI]-basic-difficulty` | `sonnet`, high | `gpt-5.6-terra`, high |
| `[AI]-advanced-difficulty` | `opus`, medium | `gpt-5.6-sol`, medium |
| `[AI]-expert-difficulty` or none | `opus`, high | `gpt-5.6-sol`, high |

Interactive and manual sessions inherit the user's native Claude Code or Codex tool settings, including
built-in subagents and web search, when their exact profile omits an override. Claude exploration defaults
to Haiku/low and ChatGPT exploration defaults to GPT-5.6 Luna/low. Auto Run workers deny those tools
regardless of permissive launch-profile settings, with extension-owned Git/GitHub restrictions enforced by
a guard hook. ChatGPT explore must pass managed-policy checks for read-only sandboxing, `never` approval,
and managed hooks. `[AI]-chrome` is an issue property, so both of that issue's workers are told to use
browser tooling when they have a tool for it and to skip the step otherwise; Claude workers additionally
launch with `--chrome`. Codex `BROWSER_USE_AVAILABLE_BACKENDS` enforcement is retained in
`chatgpt/browser.ts` but disabled, because a backend requirement contradicts that skip-if-absent policy.

Worktree runs copy ignored local `.claude`, `.agents`, `.codex`, `.pi`, and `.abd` configuration without
overwriting checkout files or copying live session state. Refuse the run when a copied path is not ignored.

## Configuration

Non-launch settings resolve in this order: `.vscode/settings.json`, `.abd/settings.json`, then
user/profile/default settings. `.abd/settings.json` accepts flat or nested keys, with or without the
`aboard.` prefix. Unknown or invalid values are reported in `Output -> aboard`.

| Setting | Default | Purpose |
| :-- | :-- | :-- |
| `aboard.bridge.port` | `4823` | Preferred loopback bridge port. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Spill longer prompts to one-use temporary files. |
| `aboard.terminals.closeOnSessionEnd` | `false` | Leave exited session terminals available. |
| `aboard.sessions.interactiveResumeMode` | `fork` | Fork live interactive delegations, or use `reuse-terminal` to send the next message into their tracked live terminal. |
| `aboard.autoRun.review` | `false` | Add the mode-specific automated review turn. |
| `aboard.autoRun.branchMode` | `per-issue` | Per-issue PRs or one cumulative branch. |
| `aboard.autoRun.exploreBeforeAddress` | `false` | Run read-only explore before a fresh worker. |
| `aboard.autoRun.issueContextDepth` | `1` | Related-issue traversal depth. |
| `aboard.autoRun.prompt` | `""` | Persistent worker guidance. |
| `aboard.autoRun.mergeStrategy` | `squash` | PR merge method. |
| `aboard.autoRun.mergeRunPullRequest` | `false` | Merge the final run PR when safe. |
| `aboard.autoRun.discardBehavior` | `record-only` | Record-only, local, or full cleanup. |
| `aboard.autoRun.worktree.enabled` | `false` | Use an isolated checkout. |
| `aboard.autoRun.worktree.root` | sibling directory | Override checkout location. |
| `aboard.autoRun.worktree.keep` | `false` | Retain a drained checkout. |
| `aboard.autoRun.worktree.setupTimeoutSeconds` | `600` | Limit scaffold setup time. |

Auto Run freezes run-specific settings for recovery. Launch configuration is not frozen; resumes use the
latest valid `.harness/config.json`.

## Command Terminal API

The bridge can open a real VS Code terminal for scripts. A command terminal is not an agent: it has no
fleet row, write lease, `ABOARD_*` credentials, or resume support. A request sends one shell command line to
the user's default shell; control characters and newlines are rejected.

| Method | Route | Purpose |
| :-- | :-- | :-- |
| `POST` | `/commands` | Open a terminal; body supports `command`, `name`, `cwd`, `env`, and `show`. |
| `GET` | `/commands` | List terminals from this activation. |
| `GET` | `/commands/<id>` | Read one terminal record. |
| `POST` | `/commands/<id>/show` | Reveal the terminal. |
| `DELETE` | `/commands/<id>` | Close the terminal. |

The record tracks terminal lifetime, not whether the typed command finished inside a still-open shell.
Malformed bodies or missing directories return `400`; unknown IDs return `404`; controlling a closed
terminal returns `409`.

Each initialized Aboard window publishes a versioned endpoint record containing `host`, `port`,
`workspaceRoot`, scoped command/delegation tokens, `pid`, and `activatedAt` in a per-user directory:

- Windows: `%LOCALAPPDATA%\abd\endpoints`
- macOS: `~/Library/Application Support/abd/endpoints`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/abd/endpoints`

Readers must match `workspaceRoot` (case-insensitively on Windows), tolerate multiple windows, reject stale
processes, and re-read after `401`; no record means no open initialized window. File names are implementation
details. Aboard-launched processes instead inherit `ABOARD_BRIDGE_PORT` and `ABOARD_BRIDGE_TOKEN`.

The in-memory full token reaches every route. The published command token reaches only `/commands`; the
delegation token reaches exactly `POST /delegations`. Endpoint records are outside workspaces, permissioned `0600`,
and each window removes only its own record on close. Runtime state and reconciliation are isolated by owner.

## Important Constraints

- Keep all Aboard-owned agent prompt text in `src/platform/prompts.ts` so the complete, provider-neutral
  prompt surface is easy for humans to find and review.
- Auto Run injects its commit contract and pinned review scope at launch; the user-owned worker skills
  supply reusable implementation and review behavior.
  AFK address and review workers require successful turns and exactly one clean descendant commit; an AFK
  review uses an empty commit when no fixes are needed. HITL without review leaves implementation edits
  uncommitted. HITL with review creates one clean local address checkpoint, mixed-resets it, and gives a
  non-committing review the immutable checkpoint range. Every HITL path advances only after exactly one
  non-empty, clean user acceptance commit.
- Workers receive read-only Git commands plus `git add` and `git commit`; Aboard owns every other
  Auto Run Git and GitHub mutation. Aboard observes acceptance commits and never creates them.
- HITL waits in `await-commit` on its recorded branch and `beforeSha`. No commit is ordinary waiting; a dirty
  partial acceptance commit is a recoverable failure that must be amended before explicit resume, and so is
  closing the terminal of the worker the user is expected to accept. Per-issue
  runs automatically integrate their internal issue PRs after acceptance. Single-branch runs publish each
  accepted commit directly to the run branch and update the cumulative PR. Only the final run PR into the
  original target may need manual merging; `mergeRunPullRequest` controls its automatic merge.
- File and Git changes, view refresh, and window focus wake acceptance observation; an internal timer
  supplies a one-second fallback. Recovery uses version-1 records. Persist mutation intent, then observed
  postconditions, before clearing the journal. The HITL mixed
  reset has its own pending action whose postcondition includes an index reset to `beforeSha`, and the
  temporary address checkpoint must never be published.
- Determine worker success only from process outcome, commit ancestry/count, and worktree cleanliness.
  Never parse final-response markup or generate/read worker commit messages.
- Auto Run adds non-removable Git/GitHub restrictions and, for worktrees, original-checkout path
  restrictions. Pi uses per-turn checkout guidance for those paths, without a filesystem sandbox.
  Shared orchestration passes provider-neutral `LaunchRestrictions`; each adapter encodes
  them natively and answers `requireEnforceableRestrictions` for what it cannot express. Worktree mode
  asks the Auto Run provider that question before creating a checkout, because an interrupted run leaves
  its checkout behind.
- Keep TypeScript strict, preserve Windows path behavior, and place cross-platform rules in `domain/` or
  `platform/` rather than duplicating them in adapters.
- Interactive delegation resumes may submit input to a matching live provider terminal when
  `sessions.interactiveResumeMode` is `reuse-terminal`. Bind Harness reply ownership before submitting
  the message. When no live session matches, use the existing fork/reopen path.

## Commands and Tests

From `apps/aboard/`:

```powershell
npm ci
npm run check
npm test
npm run test:vscode
npm run package
```

Use `npm run test:integration` for unit plus VS Code integration tests. Use `npm run e2e:full` only for the
complete disposable real-CLI journey. Invoke the `tdd` skill before adding unit or E2E tests, and the
`harness-e2e` skill for any work under `test/e2e/`.

## Useful References

- `package.json`: contributed commands, views, settings schema, scripts, and pinned toolchain versions.
- `../../temp/REFACTOR.md`: redesign product boundary; runtime code, focused tests, and scaffold assets
  remain the source of truth for implemented behavior.
- `../../docs/CLAUDE-REFERENCES/`, `../../docs/CHATGPT-REFERENCES/`, and `../../docs/PI-REFERENCES/`: mirrored official integration
  documentation; consult these before relying on remembered platform behavior.

Pi source/local VSIX support targets 1.2.0. Keep it distinct from the older pinned installer release.
Pi visible sessions use the native TUI; only existing headless modes use JSON. Workers invoke
`/skill:address-this` and `/skill:review-this`. Restricted sessions load the mandatory extension
explicitly, disable MCP and discovered extensions, and enforce allowed tools on nested calls.
The Python guard owns Git/GitHub command policy. Pi worktrees use the assigned working directory
and per-turn guidance for `protectedPaths`; filesystem isolation is not required.
Pi models inherit native settings; explicit overrides require authenticated provider/model IDs.
Pi loop delegations are unsupported. Native session lookup follows Pi's storage precedence, including
relative global settings resolved from the project and explicit `--session-dir` command arguments.
