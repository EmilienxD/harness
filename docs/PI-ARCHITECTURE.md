# Pi provider architecture proposal

Status: **21 shared skill packages, three path-guard extensions and two issue workflow extensions implemented; remaining extensions and runtime architecture proposed**.
Pi is an opt-in catalogue target for `flush-out-useless-tests` and the 20 shared packages marked
implemented below. Shared skill installation works at project and user scope; three path guards and both issue workflow packages ship; remaining extensions,
persistent runtime, Aboard, and hosted Grill integrations are pending.
This proposal defines the implementation boundaries and first release scope.
The [compatibility report](PI-COMPATIBILITY.md) retains the catalogue-wide feasibility assessment.

The API basis is the [local official reference mirror](PI-REFERENCES/README.md), examined at upstream
revision `47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf` (`@earendil-works/pi-coding-agent` 1.2.0).
This is a design baseline, not runtime certification. Before implementation, verify the installed
Pi exports and CLI against that baseline and record the version used for acceptance checks.
Rolling reference refreshes do not widen the supported runtime range automatically.

The [Pi E2E implementation guide](../tests/e2e/README.md) describes the implemented JSON/RPC
fixture, which reuses the fake OpenAI Responses endpoint and isolated Pi configuration. It was
verified against installed Pi 1.2.0. The first tool journey installs the actual catalogue package,
runs its native skill in JSON/RPC, verifies a real passing test baseline and approved cleanup,
and checks receipt-driven removal. Inference is scripted; these checks certify integration,
not the quality of an unscripted model's audit judgments.

The shared-skill batch additionally checks native command discovery and explicit invocation
for all 21 skill entry points in its 20 packages, at project and user scopes. The real Pi
parser verifies invocation policy; native tools read installed support files and write
fixture results, with exact inference counts and receipt-driven removal. These checks certify
resource integration, not unscripted workflow quality or external browser/GitHub services.

## First release scope

The following **35 packages** are the requested backlog, sorted by recommended implementation
priority. The original list defined scope, not priority. Complete the shared skill ports first,
then build the extension bridge through `command-guard` and port dependent integrations; commit
attribution and hosted grilling follow because they have the largest state/service requirements.
Within each group, favor core development workflows before optional ergonomics. Shared
prerequisites must land before their dependent packages.

"Lavish Prototype" maps to the existing `lavish` and `prototype` packages; "Git cleanup",
"next decisions", and "HITL TODOs" map to `cleanup-git`, `next-decision`, and `todo-hitl`.

**Skill** means reuse the shared instructions/scripts/CLI with Pi mappings and any required
portability edits. **Extension** means a native Pi entry point plus existing package cores;
it can also include shared skills. Rows marked implemented ship the stated Pi resources; unmarked rows remain planned.

| Priority | Package | Route | Completion requirement beyond installer support |
| --- | --- | --- | --- |
| 1 | `flush-out-useless-tests` | Skill | Implemented in 1.1.0. Project JSON/RPC and user RPC journeys verify installation, audit, approved cleanup, and removal. |
| 2 | `tdd` | Skill | Implemented. Behavior-focused red/green work and supporting references are installed. |
| 3 | `test-workflows` | Skill | Install the existing CLI; retain explicit status, execution evidence, and confirmation. |
| 4 | `resolving-merge-conflicts` | Skill | Implemented. Preserve merge/rebase intent and project verification. |
| 5 | `setup-git-worktree-maker` | Skill | Implemented. Copy necessary project Pi resources while keeping personal credentials and sessions outside worktrees. |
| 6 | `audit` | Skill | Implemented. Pi runs the audit in one session; explicit explorer delegation waits for the later runtime adapter. |
| 7 | `grill-me` | Skill | Implemented. Preserve frontier questions and explicit user decisions. |
| 8 | `breakdown-help-wanted-issue` | Skill | Implemented. Preserve clarification and authenticated GitHub lookup. |
| 9 | `read-all-adrs` | Skill | Implemented. Read the full ADR inventory with honest context limits. |
| 10 | `writing-adrs` | Skill | Implemented. Preserve decision-document conventions and supporting references. |
| 11 | `writing-for-agents` | Skill | Implemented. Shared reference includes Pi invocation, discovery, and frontmatter mechanics. |
| 12 | `zoom-out` | Skill | Implemented. Reuse abstraction mapping and codebase navigation. |
| 13 | `prototype` | Skill | Implemented. Preserve throwaway branch and interactive-only workflow; verify UI with actually available tools. |
| 14 | `lavish` | Skill | Implemented. Make argument handling portable; retain the existing Lavish CLI and external review requirements. |
| 15 | `handoff` | Skill | Implemented. Preserve temporary output and secret redaction. |
| 16 | `handoff-grilling` | Skill | Implemented. Preserve design-tree handoff and temporary output. |
| 17 | `todo-hitl` | Skill | Implemented. Support both `mark-as-todo-hitl` and `address-todo-hitl`, retaining agreement before remediation. |
| 18 | `decisions` | Skill | Implemented. Reuse retrospective decision review over available conversation context. |
| 19 | `next-decision` | Skill | Implemented. Preserve recommendations and the wait for explicit decisions. |
| 20 | `stop-overthinking` | Skill | Implemented. Reuse the practical-decision workflow. |
| 21 | `setup-command-aliases` | Skill | Implemented. Preserve shell configuration and activation; document any Pi alias explicitly. |
| 22 | `setup-text-replacements` | Skill | Implemented. Preserve AutoHotkey edit/reload behavior and Windows-only scope. |
| 23 | `command-guard` | Extension | Evaluate `bash` / `powershell` with existing Python TOML/regex rules; malformed policy blocks commands. |
| 24 | `on-read-reminder` | Extension | Implemented in 2.2.0. Successful native/shell reads remind; partial read ranges are recorded accurately. |
| 25 | `on-edit-reminder` | Extension | Implemented in 2.2.0. Successful native edits remind with the existing 120-second cooldown and branch-local read suppression. |
| 26 | `on-edit-block` | Extension | Implemented in 2.2.0. Native writes/edits require complete reads or fully delivered denial guidance on the active branch, including nested calls. |
| 27 | `prefer-fewer-comments` | Extension | Reuse scanning/budgets/exemptions; examine newly introduced comments only. |
| 28 | `no-new-documents` | Extension | Preserve draft mirrors, pending notices, user approval, and no-overwrite approval commands. |
| 29 | `issue-readers` | Extension | Implemented in 1.6.0. Prepare complete paginated `address-this` / `review-this` context through the issue graph before native skill expansion; preparation errors stop inference. |
| 30 | `issue-writers` | Extension | Implemented in 2.3.0. Supply native session draft paths for the four drafting/spec skills; intercept the fifth (`publish-issues`) through a native command with existing locks and ordering, without inference. |
| 31 | `cleanup-git` | Extension | Inject the existing read-only inventory; keep approval and live-state checks before cleanup. |
| 32 | `enable-desktop-notification` | Extension | Persist per-session opt-in and notify once at final settlement using the existing OS notifier. |
| 33 | `report-gotchas` | Extension | Reuse CLI/queue/worker; bind receipts to Pi identity and preserve idempotent reporting. |
| 34 | `commit` | Extension | Reuse staging/Git/message generation; attribute successful writes to the active Pi session branch. |
| 35 | `grill-me-in-cloud` | Extension | Prepare/publish rounds and deliver queued answers; extend hosted provider contracts and database constraints. |

That is **22 skill-led packages and 13 extension-backed packages**. These are routes, not effort
estimates: commit and hosted grilling have substantially larger state/integration requirements.

The first release does not require `subagents`, `ship`, `aboard`, `auto`, `agent-launcher`,
`mid-prompt-skills`, quota waiting, or archived packages. Keep those as future consumers of the
same provider boundaries. Tools requiring browser/search integrations must report missing
capabilities; choosing Pi or a model service does not supply those tools automatically.

## Architecture boundaries

```mermaid
flowchart TD
    Catalogue[Harness catalogue and Python installer] --> Adapter[Pi platform adapter and ownership receipts]
    Adapter --> Skills[Shared skills in Pi skills root]
    Adapter --> Entries[Selected package extension entry points]
    Adapter --> Helpers[Existing Python package cores]
    Entries --> Support[Versioned Pi support bridge]
    Support --> Helpers
    Support --> State[Branch-aware session event receipts]
    Entries --> Hosted[Hosted Grill protocol and answer relay]
    Future[Later persistent runtime and Aboard adapters] -.-> Support
```

The installer owns file placement, dependencies, reconciliation, and receipts. A Pi extension owns
native event/command translation. Existing package cores own policy parsing and deterministic
operations. Model-driven workflows remain shared skills. This keeps each catalogue selection
independent and avoids moving workflow behavior into an application dependency.

## Installer and package layout

The [platform adapters](../src/harness_cli/platforms.py) now provide `Platform.PI`, `PiAdapter`,
and centralized available/default provider sets consumed by both installer entry points.
The logical `extensions` destination is implemented for Pi at project and user scope.
Available platforms are separate from default targets: Pi is opt-in, and omitted
`--platform` retains the existing Claude/ChatGPT behavior. The interactive menu offers Pi
without adding it to an existing installation's selections automatically.

| Logical destination | Project installation | User installation |
| --- | --- | --- |
| `platform` | `<project>/.pi` | `<agent-dir>` |
| `skills` | `.pi/skills` | `<agent-dir>/skills` |
| `extensions` | `.pi/extensions` | `<agent-dir>/extensions` |
| `hooks` (Python/support files) | `.pi/hooks` | `<agent-dir>/hooks` |
| `workspace` (shared policies) | `<project>/.harness/...` | Existing user Harness configuration paths |

`<agent-dir>` defaults to `~/.pi/agent` and respects `PI_CODING_AGENT_DIR`, as documented in
[Configuration](PI-REFERENCES/docs/configuration.md). User Harness state retains its existing
`HARNESS_STATE_DIR` semantics; the Pi environment variable changes Pi resources only.

[`Target.destination_path`](../src/harness_cli/installer.py) now checks declared containment
boundaries before ancestor traversal. The Pi user scope root is its resolved agent directory,
so custom directories outside the home have distinct receipt identities. Changing
`PI_CODING_AGENT_DIR` selects another installation rather than redirecting removal of the original;
the first tool journey verifies that separation. A Pi user receipt also records a user-scope
namespace, keeping it separate from a project rooted in the same agent directory.
Claude/ChatGPT receipt identities are unchanged.

The table describes the intended full layout. The current slice supports skill and extension payloads without
configuration fragments. Pi user `workspace` payloads and configuration fragments explicitly
fail until shared-workspace ownership and native settings reconciliation are implemented;
the three path guards use hook-local user starters rather than user workspace mappings.

Source packages retain their root-level shared skill/core files and shallow `pi/` overlays:

```text
harness/<category>/<tool>/
├── harness.toml
├── SKILL.md or <skill>/SKILL.md
├── <tool>_hook.py and support modules
├── claude/ and chatgpt/ where needed
└── pi/
    └── extension.ts

Installed Pi resources:
.pi/skills/<skill>/SKILL.md
.pi/extensions/harness-<tool>/index.ts
.pi/hooks/<tool>_hook.py
.pi/hooks/pi-support/<bridge modules>
```

The file mappings install the entry point as `index.ts`; source overlays never appear inside
installed skills. Python helpers and bridge modules stay outside extension auto-discovery.
Map only each skill's shared files, excluding ChatGPT metadata. Prefer Pi-owned copies in
`.pi/skills`; Pi also discovers `.agents/skills`, so test native name collisions with ChatGPT
and Claude symlink installations. Use startup diagnostics to identify the selected skill source.
Do not silently disable the user's own shared skill discovery.

Use conventional resource directories for the first release; most packages need no Pi settings
fragment. Before adding fragments, move configuration addition/shared-removal accounting behind
the adapter: `installer.py` currently calls `settings_merge.additions` and `remove_shared`
directly. Pi settings resource filters and package objects need native identity semantics, not
Claude hook-array reconciliation. Preserve unrelated resource filters, models, tools, and settings.
Harness must not own Pi authentication, trust decisions, native sessions, or unrelated extensions.
[Pi Packages](PI-REFERENCES/docs/packages.md) remain an optional later distribution format;
Harness continues to own the files it installs rather than introducing a second installer owner.

Pi itself is an external prerequisite for this release. The current host-action schema supports
pinned Python tools and VSIXs; adding npm/CLI ownership would be a separate design change.

## Shared Pi support and Python reuse

The path guards ship a non-selectable `harness/extension/pi-support` package with versioned transport,
event normalization and branch receipt utilities for these three guards. Issue workflow input routing and native publication also ship; broader provider support remains proposed. Package cores own the TOML policies.
Each selected extension imports the installed support modules and registers its own behavior.
Skills without extension behavior do not depend on it.

The installer filters [manifest dependencies](../src/harness_cli/manifest.py) by their optional
platform list before catalogue resolution and receipt accounting. Extension packages declare a version-constrained, Pi-only, coupled
dependency on `pi-support`; existing dependencies without a filter retain their behavior.
Multiple Pi packages share one receipt-owned copy, removed when its last dependent is removed.
This avoids requiring the bridge for Claude/ChatGPT and avoids one bridge copy per package.

Start with bounded subprocess calls per relevant event. Choose Python through the installer's
existing interpreter resolution and record the launch argv; send requests as UTF-8 JSON on stdin,
parse one versioned JSON response, and keep diagnostics on stderr. Propagate cancellation,
timeouts, output limits, and exit/protocol errors. Never build shell commands from prompt text.
A persistent worker can follow measured latency evidence; it is not required for initial support.

Reuse Python parsing, regexes, shell detection, Git/GitHub logic, publishing, and notification
code. Extract callable core functions where a current hook mixes those operations with provider
I/O. Retain existing hook entry points for Claude/ChatGPT. Pi passes normalized operations into
the cores instead of fabricating Claude transcripts or emulating the entire hook protocol.

The proposed bridge request carries protocol version, operation, cwd, provider `pi`, session
ID/file, active branch anchor, tool-call/parent-call IDs where present, native tool name/input,
and observed outcome. Responses distinguish allow/block, model guidance, deterministic command
output, and diagnostics. Individual cores receive only the fields they need. Successful command
output does not imply a request to start a model turn.

## Event handling and state

The mapping below follows [Extensions](PI-REFERENCES/docs/extensions.md) and the exported
[API types](PI-REFERENCES/src/core/extensions/types.ts). It is the proposed Harness adapter
contract, with failure behavior exercised before a package is advertised as supported.

| Boundary | Pi API | Harness responsibility |
| --- | --- | --- |
| Bind/recover identity | `session_start` | Rebind on startup/reload/new/resume/fork; rebuild branch state. |
| Change active ancestry | `session_tree` | Rebuild permissions/attribution and invalidate stale pending context after tree navigation. |
| Prepare a workflow | `input` / `before_agent_start` | Supply context for the actual explicit invocation once. |
| Deterministic user command | `registerCommand` | Execute the core and display status with no agent inference turn. |
| Deny a model tool operation | `tool_call` | Normalize native schemas and block before execution. |
| Record outcome / append guidance | `tool_result` | Attribute observed changes; deliver informational guidance after success. |
| Persist branch-local metadata | `appendEntry` / session manager | Record receipts and reconstruct only the active ancestry. |
| Refresh compacted context | `session_compact` / next-run preparation | Restore required package context with deduplication. |
| Continue for actionable feedback, later | `agent_before_settle` | Require concrete new context and bounded continuation. |
| Notify final completion | `agent_settled` | Notify once; do not mistake `agent_end` for final completion. |
| Release resources | `session_shutdown` | Abort pending transport and release timers/listeners idempotently. |

Factories register behavior only. Start session resources at session start or on demand and
dispose them on shutdown. Preserve original tool content, details, usage, and error status;
when returning replaced `content`, explicitly preserve `structuredContent` for additive guidance.
Read/edit reminders must not convert a successful operation into an error.

Session JSONL is a tree ([Session format](PI-REFERENCES/docs/session-format.md)). Identity is
the provider plus native session ID and exact saved file, with an active branch anchor for
state reconstruction. Terminal PID is execution identity only. Successful-read receipts include
the delivered range and guidance identity; an attempted or partial read never proves a complete
guide was read. Keep current package-specific delivery/cooldown behavior explicit.

Record events directly, including nested tool calls. Pi's nested execution passes through tool
events but does not create transcript tool entries; its bounded `nestedCalls` summary can omit
arguments. It is insufficient as the sole source for commit attribution or read permissions.
Persist minimal branch-linked receipts for successful reads/writes and command consumption,
with call IDs for deduplication. After reload, recover from receipts on the active ancestry;
abandoned branches do not authorize edits or contribute a previous-message selection.

Commit additionally needs a conservative attribution ledger: observed successful file changes,
per-call pre/post evidence where needed, and already committed changes. Account for recognized
shell writes, failed commands with partial mutations, parallel calls, nested calls, prior commits,
and external changes. A successful shell exit alone does not identify all files it changed.
Preserve existing-index protection; incomplete attribution must stop the automated commit and
report the uncertainty for user resolution, never stage every dirty file. Branch changes do not
rewind the working tree, so verify current file/index evidence against branch receipts.

## Commands and explicit skill invocation

Shared workflows use Pi's native `/skill:name arguments`. Pi appends arguments to the request;
Claude substitutions such as `$ARGUMENTS`, fork semantics, and tool permissions need explicit
portability treatment. Preserve `disable-model-invocation: true` for user-only skills.
`enableSkillCommands` controls interactive discovery, not whether a manually entered command
can execute ([Skills](PI-REFERENCES/docs/skills.md)).

Register native `/commit`, `/publish-issues`, `/approve-doc-draft`, `/reject-doc-draft`, and
`/enable-desktop-notification` handlers. Keep existing options and error behavior. These commands
create no Pi agent inference request; `/commit --ai` may still call its existing explicitly
requested message-generation service. Measure those requests separately.

Short extension commands dispatch before the ordinary `input` handler. Handle both `/name` and
`/skill:name` for deterministic commands so direct skill invocation cannot load an interception
failure body or start an accidental agent turn. For prepared workflows such as issue readers,
cleanup, and cloud grilling, choose and test one routing path per invocation: resolve the shared
skill, prepare package context, then submit once. Extension-sent messages only expand commands
when `expandPromptTemplates` is requested; avoid recursive alias expansion. Test typed input,
RPC input, extension submission, missing arguments, and errors independently.

Explicit invocation remains the source of workflow authorization. Installation supplies tools
and guards; it does not start issue publication, Git cleanup, or an interview automatically.

## Hosted grilling without an Aboard dependency

`grill-me-in-cloud` is in the requested release, while the full Pi Aboard adapter is deferred.
Propose a session-scoped relay owned by the grilling extension, reusing existing hosted delivery
contracts. It polls/claims queued answers, submits them through Pi's native user-message API,
and acknowledges only after a correlated, persisted user-message receipt confirms acceptance by
the bound session. The void return from `sendUserMessage` alone is insufficient confirmation.
It needs no Harness ask/reply runtime and keeps the real Pi TUI visible.

The relay and a later Aboard relay must compete through the same delivery lease/idempotency
rules, so both running cannot double-submit an answer. Persist delivery IDs and submission receipts
before retrying; recover an accepted-but-unacknowledged submission without resending it. Rebind on
session replacement, invalidate stale round context after branch navigation, cancel polling on
shutdown, and preserve queued answers on disconnect, failed submission, or loss of ownership.
Keep current configuration/credentials outside model-facing context.

This requires additive `pi` support in [`protocol/grill/v1/states.json`](../protocol/grill/v1/states.json),
hosted schemas/API validation, Pi session/title extraction, and a **new** database migration
widening existing provider constraints. Do not rewrite the initial migration. A publication-only
port is incomplete: round publication, assets, presence, queued answers, and confirmed delivery
must pass together. Development and migration preparation precede any separately authorized
deployment; an older hosted service needs an explicit unsupported-provider error.

## Guard coverage and admission

Pi project trust controls resource loading, and extensions execute with the user's permissions
([Security](PI-REFERENCES/docs/security.md)). Installing files does not prove a required guard
loaded. Verify trusted project discovery, bridge readiness, supported native tool schemas, and
required registrations before a guarded automated launch. Report missing resources in ordinary
sessions; refuse a Harness launch requiring mandatory restrictions when that evidence is absent.
Do not silently grant trust or copy authentication state.

Cover native `read`, `edit`, `write`, `bash`, and `powershell` plus recognized search/read paths
as required by each package. Nested calls require the same decisions as direct calls. New custom
or MCP mutators require explicit schema adapters; unknown mutation coverage is a reported gap,
and mandatory-restriction launches reject it. Other extensions can mutate tool inputs after a
guard handler, so controlled loading/order is also required for those launches.

Guard callbacks do not intercept arbitrary extension filesystem/subprocess operations, and a
tool list is not OS isolation. Preserve this guardrail boundary in user documentation. Python
transport/policy failure blocks operations covered by a blocking guard; informational extensions
retain the tool result and emit a visible diagnostic. Do not describe disabled/unloaded guards
as enforceable. Strong restriction guarantees need OS/container enforcement.

## Delivery plan and acceptance gates

| Work package | Contents | Completion gate |
| --- | --- | --- |
| A. Provider foundation | Registry/default separation, Pi adapter/roots, receipt identity, extension destination, platform-filtered dependencies, prerequisite/trust diagnostics. | Project/user/custom-agent-dir install, upgrade, dry-run, modified-file protection, shared dependencies, and cross-provider removal behave correctly. |
| B. Shared workflows | The 22 skill-led packages, in backlog order where practical; Lavish argument and skill-mechanics edits. | Actual trusted Pi discovery selects intended files; user-only invocation and scripts/CLI paths work; gaps are explicit. |
| C. Extension foundation | Versioned bridge, routing, branch receipts, cancellation, result composition, then `command-guard`. | Denied direct/nested calls leave no mutation; malformed policies, unavailable Python, and bridge errors have the specified behavior. |
| D. Priority integrations | Issue readers/writers, commit, document/read/edit/comment guards, then cleanup, notifications, gotchas. | Session ownership, staging protection, draft approval, success-only guidance, opt-in notifications, and idempotent receipts match existing contracts; deterministic commands make zero Pi inference requests. |
| E. Hosted interview | Grilling extension, standalone answer relay, hosted additive schema/migration changes. | Publish/answer/reconnect/reload flows work, delivery is acknowledged correctly, and competing relays do not duplicate answers. |

Do not declare all catalogue tools Pi-supported at once. Add `[platforms.pi]` mappings and bump
each package version when its payload/support actually ships. The proposed `pi-support` package
and dependency syntax are absent today. Each advertised package needs its own applicable gate;
passing a skill discovery check does not certify an extension-backed command.

Use existing installer/core unit tests for reconciliation and policy semantics. Real-CLI journeys
must exercise Pi with isolated agent/config/session directories and authenticated loopback model
inference; use the `harness-e2e` skill when extending that infrastructure. Assert files/index/GitHub
effects, event/schema contracts, receipt state, and request counts. Agent prompt wording is not
a test contract. Include Windows/POSIX paths, discovery collisions, failed/aborted turns, nested
and parallel calls, session fork/reload/compaction, unknown tools, and protocol/cancellation errors.
Keep Claude/ChatGPT regression checks passing.

## Later provider consumers

Persistent `run`, `ask`, `reply`, `resume`, and `watch` remain in the independently packaged
Python session runtime. A later Pi runtime adapter supplies exact launch/resume/fork identity,
JSON/RPC progress and semantic success parsing, branch-aware previous messages, model selection,
and interrupted-execution recovery. Harness `provider: pi` identifies the agent host; Pi's own
model `--provider` identifies a service. Avoid binary Claude/ChatGPT fallbacks and a universal
Pi model list. Preserve unknown telemetry rather than inventing context percentages.

`ship` follows that runtime adapter, preserving inboxes, wait tokens, bounded feedback, result
replay, and one implementer per worktree. Aboard follows with a native platform adapter, visible
terminal binding, prompt receipts, worktree setup, and restriction admission. JSON exit status
or RPC prompt acceptance alone does not prove a successful completed run. Native Pi RPC is a
headless transport; adopting it must not silently replace the visible-terminal product.

These future adapters consume the same event/identity contracts without making the initial
35 packages depend on their implementation. The compatibility report retains their detailed
feasibility and broader release gates. The 21 shared skill packages and installer slice are implemented in
the checkout; the three path guards and both issue workflow packages also ship; remaining adapters, service migrations, deployment, and release remain pending.

## Shipped path-guard slice

`on-read-reminder`, `on-edit-reminder`, and `on-edit-block` 2.2.0 use `pi-support` 1.0.0
through a Pi-only coupled dependency. The bridge imports each package's existing Python parser
and message builders. It selects the same uv/Python preference as the installer and records
launch argv in session receipts. Subprocess requests and responses are versioned JSON, bounded
at 2 MiB and ten seconds, with cancellation on session replacement/shutdown. Guard transport
errors deny native edits; reminder errors append diagnostics while preserving successful results.
Original tool content and structured output are preserved.

User policy starters live beside Python hooks in the effective Pi agent directory. This avoids
adding user workspace ownership to this slice. Shared home and project policies still load later.
Branch receipts record observed ranges and content digests, complete denial deliveries, and
reminder times. State comes from active ancestry on every event, including nested calls, so
reload/resume and tree navigation do not import abandoned-branch permissions. A denial records
only guidance actually inlined within the existing message budget, after an observed
`tool_execution_end` error carries that denial. Pi skips `tool_result` for denied calls.

`npm run test:pi-path-guards` in `tests/e2e/` installs real catalogue payloads and tests Pi 1.2.0
against the authenticated fake OpenAI Responses API. JSON/RPC and project/user checks cover
reminders, cooldown, failed calls, denial/retry, partial-read coverage, shell reads, nested tools,
reload, tree navigation, exact file effects, request counts, and coupled removal. These checks
certify native read/write/edit integration on Windows; they do not certify arbitrary shell
mutations, third-party tools, restricted-launch admission, or a security sandbox. The broader
bridge/event contracts above remain the proposal for later consumers.

## Shipped issue workflow slice

`issue-readers` 1.6.0 and `issue-writers` 2.3.0 depend on `pi-support` 1.1.0 for
bounded, cancellable Python calls. Native input interception runs before `/skill:` expansion;
short slash aliases expand through the selected native skill too. The extension checks that
the skill is available, preserves images, and stops workflow preparation during another active
turn. Context travels with the actual input rather than mutable pending state. Session replacement,
tree navigation and shutdown cancel transport and suppress stale delivery. Issue helpers have a
two-minute deadline and the bridge's 2 MiB input/output bounds; oversize context fails instead of
silently truncating requirements. Interpreter cancellation terminates the subprocess tree.

Readers reuse checkout admission and local review scope from the existing hook, and all-page
GraphQL retrieval from `issue_graph.py`. Primary issues must be open for addressing. Relation depth
is still `HARNESS_ISSUE_CONTEXT_DEPTH`; parent, sub-issue, blocker, blocking and body references
are deduplicated, and every included issue retains its full paginated context.

Writers reuse `issues_core.py` without changing publishing semantics. UUIDv5 identities use
`harness:issues:pi:<native-session-id>`; reload/resume retain that batch, while native new/fork
sessions select another. `/publish-issues [--dry]` and `/skill:publish-issues [--dry]` are consumed
without inference. Repository locks, draft ordering, parent links, crash recovery, stale sweeping
and next-prompt notices remain owned by the shared core.

`npm run test:pi-issues` installs actual catalogue payloads at project and user scopes on Pi 1.2.0.
Real JSON/RPC tools implement and review a fixture, stop dirty addressing before inference, write
the supplied session draft path, and publish through a local fake GitHub CLI. Checks include dry-run,
invalid options, reload, session isolation, all five native skill routes, exact request counts,
starter ownership and last-dependent bridge removal. This certifies native integration and shared
core reuse, not unscripted model judgment.

`npm run e2e:pi-issues:live` additionally verifies real `gh` against the private
`EmilienxD/harness-e2e` repository at project and user scope, with real Pi 1.2.0 JSON/RPC
and fake inference. A parent/child draft batch is published with labels, rewritten references
and a real parent link. Both readers receive the live issue graph and a maintainer comment.
Dry-run leaves GitHub untouched and publication uses zero inference. Only the run's UUID-tagged
issues and newly added gateway labels are cleaned; existing repository state is preserved.
