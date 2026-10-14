# Pi provider investigation and integration report

The [Pi architecture proposal](PI-ARCHITECTURE.md) extends this investigation with the user's
requested 35-package backlog and concrete provider boundaries. It owns first-release scope and
sequencing; this report retains catalogue-wide feasibility and broader integration considerations.
Current implementation includes `flush-out-useless-tests` and the 20 shared skill packages
listed as implemented in the architecture backlog, with opt-in Pi installation. Extension-backed
tools now include the three path guards, both issue workflow packages, and the cloud interview with its standalone relay. The hosted Pi migration/application are deployed; real Pi project/user journeys pass against local and production boards. Remaining extensions and runtime integrations remain proposed.

Follow-up preparation now provides a [real Pi JSON/RPC E2E environment](../tests/e2e/README.md),
verified against installed Pi 1.2.0. The investigation results below predate that bootstrap;
the first tool has a workflow journey and the shared-skill batch has native discovery/invocation
checks. The feasibility tables below describe original port requirements; consult the architecture
backlog for current shipped status. The three path guards, both issue workflow packages, and cloud interview ship; remaining extensions, runtime, and Aboard remain proposed.

## Executive conclusion

**Add Pi as Harness's third agent host.** Its shared skill format and in-process TypeScript extension API are a good match for the catalogue's deliberate, independently selectable workflows. Skills mostly retain their implementation; extensions can replace provider-specific hook entry points while preserving the existing Python policy, Git/GitHub, publishing, and notification logic.

The difficult work is not skill installation. It is persistent ask/reply and `/ship` continuation, Aboard's provider/lifecycle boundary, and preserving restrictions when Pi can load arbitrary extensions and MCP tools. Pi runs with its operating-system user's permissions; its extension guards are not a Codex-style operating-system sandbox.

Recommendations:

1. Introduce an installer adapter and ship shared skills plus a small, tested extension bridge.
2. Port guards and deterministic commands using existing Python cores, not independent TypeScript rewrites of every policy.
3. Complete the requested tool rollout, including a standalone hosted-answer relay; then add native Pi session orchestration, Aboard, and `/ship`.
4. Do not install `redirect-subagents` on Pi: there is no built-in Claude `Agent` tool to redirect. Offer Harness delegation instead.
5. Keep `usage-limit-wait` conditional on the selected model service and a verified quota/reset reader. There is no documented universal Pi subscription-window API.

**The original investigation delivered research, mirrored references, and synchronization wiring.**
Follow-up work added `--platform pi` skill installation and the first tool's E2E journeys.
The three Pi path guards and both issue workflow packages are implemented; other extensions, persistent runtime, and Aboard remain unimplemented. Feasible below describes
the research assessment; consult the architecture's implementation status for shipped slices.

## Scope and evidence

The investigation accounts for **48 active catalogue packages (47 selectable, plus the coupled/internal `auto` package)**, all their skill/command families, the persistent Python runtimes, Aboard, the hosted Grill service, the installer, and deterministic E2E integration boundaries. Five archived tools and one unmanifested in-progress tool are assessed separately. Archived directories remain excluded from discovery; no package was reactivated.

Baseline:

- Harness revision: `0408dd5ac0f7e9520447b3b3d264a85c4bed16e4`.
- Pi upstream revision examined: [`47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf`](https://github.com/earendil-works/pi/tree/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf).
- Upstream coding-agent package metadata at that revision: **`@earendil-works/pi-coding-agent` 1.2.0**, Node **>=22.19.0**, MIT license.
- `badlogic/pi-mono` redirects to the canonical repository, [`earendil-works/pi`](https://github.com/earendil-works/pi). Older `@mariozechner/pi-coding-agent` material is not authoritative for this snapshot.

Method: enumerate manifests through actual catalogue discovery; inspect shared skills where provider mechanics matter; trace hook input/output, transcript assumptions, policy files, session launch/resume and result delivery; inspect Aboard's adapter/restriction contracts and Grill's provider validation/database constraints; compare those boundaries with official Pi documentation, exported API declarations, and relevant upstream source and extension examples. No third-party extension was adopted or executed.

Evidence anchors used throughout:

| Boundary | Harness evidence | Pi evidence |
| --- | --- | --- |
| Catalogue/platform declaration | `src/harness_cli/manifest.py:16`, `src/harness_cli/platforms.py:18` | [Configuration](PI-REFERENCES/docs/configuration.md), [Packages](PI-REFERENCES/docs/packages.md) |
| Shared skill mechanics | Package manifests and associated shared `SKILL.md` files | [Skills](PI-REFERENCES/docs/skills.md), [Slash commands](PI-REFERENCES/docs/slash-commands.md) |
| Tool policy reuse | `harness/guards/command-guard/command_guard_hook.py:45`, `harness/building/ship/ship_hook.py:151` | [Extensions](PI-REFERENCES/docs/extensions.md), [tool-event types](PI-REFERENCES/src/core/extensions/types.ts) |
| Session-scoped commit attribution | `harness/engineering/commit/commit_hook.py:372`, `harness/engineering/commit/commit_hook.py:2005` | [Session format](PI-REFERENCES/docs/session-format.md), [JSON events](PI-REFERENCES/docs/json.md) |
| Delegation and continuation | `harness/productivity/subagents/runtime/src/subagents_runtime/sessions.py:455`, `harness/productivity/subagents/runtime/src/subagents_runtime/hooks.py:210` | [CLI](PI-REFERENCES/docs/cli.md), [RPC](PI-REFERENCES/docs/rpc.md), [SDK](PI-REFERENCES/docs/sdk.md) |
| Loop report/wait protocol | `harness/productivity/subagents/runtime/src/subagents_runtime/loop.py:213` | `agent_before_settle` and `agent_settled` in [extension API](PI-REFERENCES/src/core/extensions/types.ts) |
| Aboard integration | `apps/aboard/src/platform/agent-platform.ts:46`, `apps/aboard/src/platform/prompt-submissions.ts:16` | [CLI integration](PI-REFERENCES/docs/cli-integration.md), [RPC extension UI](PI-REFERENCES/docs/rpc-extension-ui.md) |
| Hosted Grill constraints | `apps/grill/src/lib/grill-contract.ts:4`, `apps/grill/supabase/migrations/0000_create_hosted_grill_board.sql:5`, `protocol/grill/v1/states.json:3` | [Extensions](PI-REFERENCES/docs/extensions.md), [Session format](PI-REFERENCES/docs/session-format.md) |
| Safety | `apps/aboard/src/domain/capability.ts:4` | [Security](PI-REFERENCES/docs/security.md), [Containerization](PI-REFERENCES/docs/containerization.md) |

The local mirrors track upstream `main` and will change; the revision link above fixes the basis of this report. References provide API evidence, not model-quality, performance, or subscription-policy guarantees.

## What Pi supplies, and what changes for Harness

### Skills are largely portable

Pi implements Agent Skills, supports bundled scripts/references, recursively discovers skill directories, and honors `disable-model-invocation: true`. It discovers `.pi/skills` and `~/.pi/agent/skills`, and also `.agents/skills` at user/project scope. The latter creates an important interaction with existing ChatGPT installations: Pi may discover ChatGPT-installed shared skills even before Harness declares Pi support.

The explicit native invocation is **`/skill:name arguments`**, not Claude's `/name` or ChatGPT's `$name`. Arguments are appended as a user request. Do not assume Claude `$ARGUMENTS` substitution, shell injection, `context: fork`, `allowed-tools` enforcement, or ChatGPT `agents/openai.yaml` policy controls are reproduced by Pi. For Harness's user-only skills, the shared `disable-model-invocation` field is the relevant Pi control. `lavish` specifically contains a `$ARGUMENTS` placeholder that needs a small portability edit or adapter treatment.

Prefer provider-owned `.pi/skills` installation initially. It avoids making Pi own the same installed files as ChatGPT, although native `.agents` discovery still needs collision tests and truthful startup diagnostics. A blanket disable of shared discovery would also hide the user's own skills and is not an acceptable silent workaround.

### Hooks become extensions, not another hooks JSON dialect

Pi auto-loads TypeScript/JavaScript extension entry points, supports multi-file `index.ts` directories, and uses `jiti` for local TypeScript. Native extension commands can complete without calling a model. A Pi adapter can be substantially cleaner than synthesizing a denied prompt merely to execute `/commit`.

Relevant API mappings:

| Current Harness operation | Pi equivalent | Important distinction |
| --- | --- | --- |
| User prompt preparation | `input` transform, `before_agent_start` custom message | Registered extension commands dispatch before `input`; prepare command-specific context in the command handler. |
| Zero-model command interception | `pi.registerCommand()` | Native command handler; never invoke the fallback error-only skill body. |
| Pre-tool deny | `tool_call` returning `{ block: true, reason }` | Inspect Pi tool names and schemas, not Claude names unchanged. |
| Post-tool guidance | `tool_result` content augmentation or queued custom context | Preserve original content/details, structured content, usage, and error status; guidance is not a claim that an edit failed. |
| Session initialization/resume | `session_start`, session manager identity | Rebind after reload/session replacement; do not identify a conversation by terminal PID alone. |
| Compaction recovery | `session_compact`, contextual refresh before next run | Re-supply inbox/loop context without duplicating every startup entry. |
| Stop that can continue the model | `agent_before_settle` with entries and `continue: true` | A continuation needs runnable context, such as a custom message, and a bounded state machine. |
| Final completion notification | `agent_settled` | Notification-only; `agent_end` can be followed by retries, recovery, or queued work. |
| Durable branch-aware state | `pi.appendEntry()` plus session manager branch traversal | Abandoned branches must not contribute read permissions, previous-message selection, or tool attribution. |
| New model-callable operation | `pi.registerTool()` | Useful for delegation or publishing helpers, but user approval and explicit invocation remain Harness policy. |

Pi default tools are `read`, `bash`, `edit`, and `write`; `powershell`, `grep`, `find`, and `ls` are available. Current Pi also supports MCP and codemode. Codemode nested `ctx.executeTool()` calls pass through tool events, but direct extension subprocesses, raw filesystem calls, and direct tool-definition execution are not made safe by those events.

### Session transport is flexible, but lifetimes differ

- **Visible interactive work:** real Pi TUI in the existing terminal model, with an extension reporting lifecycle and handling inbound messages. Keep human takeover visible.
- **Automatic one-shot delegation:** JSON mode for structured progress and final-message reconstruction. Persist sessions where continuation is required; do not copy the upstream subagent example's ephemeral lifetime blindly.
- **Long-lived machine control:** RPC is a good subprocess boundary for Python. It supports prompt/steer/follow-up, abort, session inspection, fork/clone/switch, model selection, and last assistant text.
- **Embedded TypeScript:** SDK is feasible for specialized future hosts, but replacing Aboard's visible-terminal model with an embedded agent would change the product unnecessarily.

**JSON-mode exit status alone is not success.** A failed or aborted assistant response can appear in the event stream with a zero process exit. Inspect final message stop reason, error/abort records, and final settlement. A successful RPC `prompt` response means accepted/queued/handled, not completed; when disposition is `handled`, no model run need follow.

Pi session JSONL is a tree of `id`/`parentId` entries, not a flat chronological conversation. Store provider ID, session file and active branch/leaf as needed; use runtime branch APIs when available. Resuming an arbitrary ID that silently creates a new conversation must never be treated as successful continuation.

Harness's delegation skills currently promise automatic file loading for inline `@path` references. Pi documents `@file` CLI attachments, while RPC explicitly rejects those CLI arguments; that is not a guarantee that embedded `@path` text in a delegated prompt loads a file. The Pi adapter must explicitly attach/read those references or revise the provider-specific guidance so callers receive the same necessary context without a false loading promise.

## Complete active catalogue assessment

Routes:

- **S — Shared:** same instruction/script/CLI implementation, with installer mapping and small invocation/portability edits where noted.
- **E — Extension:** same user result, a Pi-native extension entry point, and reuse of existing cores where possible.
- **P — Provider adapter:** significant session/host adapter work, not a hook-name substitution.
- **C — Conditional:** feasibility depends on model-service capability absent from the generic Pi interface.
- **N — Not applicable:** retain the original-provider package or point to the equivalent workflow instead.

Effort is relative implementation complexity: **low**, **medium**, **high**. It includes the package-specific work after the installer/bridge foundation, not elapsed-time promises. Priority **1**, **2**, and **3** below are the investigation's broad feasibility groupings, not the requested delivery order. Use the [architecture backlog](PI-ARCHITECTURE.md#first-release-scope) for that order and its prerequisite gates. High confidence in documented extension/skill mechanisms does not remove the need for real-CLI tests; lifecycle and service-specific parity remain medium-confidence until prototyped.

### Building — 6 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`flush-out-useless-tests`](../harness/building/flush-out-useless-tests/harness.toml) | Yes / S | Reuse scoped passing-test audit and approval workflow unchanged; standard read/shell tools suffice. | Low / 1 |
| [`issue-readers`](../harness/building/issue-readers/harness.toml) | Yes / E | Preserve `address-this` and `review-this` starter ownership. Prepare bounded issue/commit context through native command wrappers or input preprocessing; reuse issue graph/read-only Git/GitHub logic. Missing prerequisites must stop preparation, not silently send an incomplete request. | Medium / 1 |
| [`issue-writers`](../harness/building/issue-writers/harness.toml) | Yes / E | All five skills: `draft-issue`, `draft-issues`, `to-spec`, `to-spec-draft-issue`, `publish-issues`. Reuse `issues_core.py`; supply session draft paths before drafting. Register native `/publish-issues [--dry]` with no model call, retaining locks, parent/blocker ordering, notices and cleanup. Namespace Pi session identity separately. | Medium / 1 |
| [`ship`](../harness/building/ship/harness.toml) | Yes / E, session-dependent | Lead skill, issue-context and stub-contract CLIs remain reusable. Needs Pi Lead binding, loop implementer reports/wait tokens, context telemetry and pre-tool loop restrictions. Git/GitHub ownership, workflow stamping, feedback/freshness caps, released implementer adoption and PR resume must remain unchanged. | High / 2 |
| [`tdd`](../harness/building/tdd/harness.toml) | Yes / S | Reuse behavior-focused red/green workflow and references. No provider-specific mechanism. | Low / 1 |
| [`test-workflows`](../harness/building/test-workflows/harness.toml) | Yes / S | Existing Markdown/hashing CLI is provider-neutral. Keep explicit status/confirmation and `uv` tool ownership; actual browser/UI acceptance still needs appropriate project tools. | Low / 1 |

### Engineering — 3 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`commit`](../harness/engineering/commit/harness.toml) | Yes / E | Native `/commit`, `--dry`, `--ai`; reuse staging, existing-index protection, Git and Gemini core. Add Pi successful-write attribution and session narrative reader; never stage every dirty file as a shortcut. Handle shell writes, failed tools, concurrent calls, forked histories and prior commits. Use a Pi trailer/product label. | High / 1 |
| [`resolving-merge-conflicts`](../harness/engineering/resolving-merge-conflicts/harness.toml) | Yes / S | Same merge/rebase intent tracing, resolution and verification through read/edit/shell tools. | Low / 1 |
| [`setup-git-worktree-maker`](../harness/engineering/setup-git-worktree-maker/harness.toml) | Yes / S | Same project-native setup discovery and generated script. Include ignored Pi configuration when genuinely needed; keep authentication/session state out of copied project assets. | Low / 1 |

### Guards — 10 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`command-guard`](../harness/guards/command-guard/harness.toml) | Yes / E | `tool_call` checks `bash`/`powershell` command against the same ordered TOML/Python regex policy. Preserve fail-closed behavior for broken policy. Do not port Python regexes to JavaScript without a compatibility contract. | Low–medium / 1 |
| [`no-new-documents`](../harness/guards/no-new-documents/harness.toml) | Yes / E | Guard `write` creation, relevant shell copy/move/create paths and any enabled mutators; preserve draft mirrors, pending notices, user approval and no-overwrite checks. Native `/approve-doc-draft` and `/reject-doc-draft` must complete without a model call. `edit` normally cannot create a file; distinguish creation from an existing-document edit. | Medium / 1 |
| [`on-edit-block`](../harness/guards/on-edit-block/harness.toml) | Yes / E | Block `edit`/`write` until required guidance has actually been delivered/read. Existing TOML matching transfers. Replace Claude transcript traversal with Pi branch-aware successful-read/delivered-guidance state, retaining exclusions, missing guidance behavior and readable-guide delivery. | Medium / 1 |
| [`on-edit-reminder`](../harness/guards/on-edit-reminder/harness.toml) | Yes / E | Successful edit result adds relevant guidance context; preserve cooldown/deduplication and already-read tracking. Let the edit land, then ask for compliance fixes. | Medium / 1 |
| [`on-read-reminder`](../harness/guards/on-read-reminder/harness.toml) | Yes / E | Successful `read` and recognized shell reads trigger matching guidance through tool-result context. Preserve shared ordered rules and path semantics. Treat partial reads explicitly rather than asserting an entire guide was read. | Low–medium / 1 |
| [`prefer-edit-tool`](../harness/guards/prefer-edit-tool/harness.toml) | Yes / E | Pi has dedicated `edit`/`write`, so shell-write nudges are useful even though ChatGPT currently declares this package unsupported. Reuse shell detection; change tool names in guidance. This is a nudge, not a denial. | Low / 1 |
| [`prefer-fewer-comments`](../harness/guards/prefer-fewer-comments/harness.toml) | Yes / E | Reuse language/comment scanning, budgets and exemptions. Normalize Pi `edit` old/new text and `write` content, or compare per-call before/after snapshots, then append guidance only after success. Avoid blaming pre-existing comments or racing sibling writes. | Medium / 1 |
| [`prefer-read-tool`](../harness/guards/prefer-read-tool/harness.toml) | Yes / E | Pi's dedicated `read` makes the same reviewability nudge meaningful. Reuse shell-read detection and reference Pi's lowercase tool. Search tools are legitimate searches, not violations. | Low / 1 |
| [`redirect-subagents`](../harness/guards/redirect-subagents/harness.toml) | No as a Pi-installed guard / N | Intercepts Claude's built-in `Agent`; Pi has no corresponding core tool. Use Harness `subagents` or a Harness-owned Pi tool instead. Separately, Pi can be an alternate child executable for this guard when the **parent remains Claude**, after defining/configuring its invocation contract. | No Pi port / 3 |
| [`usage-limit-wait`](../harness/guards/usage-limit-wait/harness.toml) | Conditional / C | Token/cost telemetry is not subscription quota. Select a backend-specific reset reader only when supported, bind it to the actual Pi model service/account, and retain cancellation, bounded waits and fail-open reader errors. Generic rate-limit retry is already available in Pi and is not hours-long subscription-window parity. | High/uncertain / 3 |

### Planning — 9 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`audit`](../harness/planning/audit/harness.toml) | Yes / S | Same evidence-based read-only audit. Single-agent path is portable; explicit explorer delegation and its completion contract depend on Harness `subagents` support. | Low alone; session-dependent / 1 |
| [`breakdown-help-wanted-issue`](../harness/planning/breakdown-help-wanted-issue/harness.toml) | Yes / S | Same request clarification and optional oldest-GitHub-issue lookup. Requires `gh` authentication, not a Pi API. | Low / 1 |
| [`grill-me`](../harness/planning/grill-me/harness.toml) | Yes / S | Same frontier-based conversational interviewing; keep explicit user decisions. | Low / 1 |
| [`grill-me-in-cloud`](../harness/planning/grill-me-in-cloud/harness.toml) | Yes / E, cross-service change | Reuse round/asset/outbox/publishing core; supply fresh paths and publication results with extension lifecycle/tool events. Add `pi` to hosted API schemas, protocol vocabulary, **new database constraint migration**, and session/title binding. The architecture proposes a standalone Pi answer relay first, with Aboard relay support later. A Pi hook alone cannot make current server acceptance work. | High / 2 |
| [`lavish`](../harness/planning/lavish/harness.toml) | Yes / S with small edit | `npx lavish-axi` artifact/review workflow is independent of Pi. Remove or normalize literal Claude `$ARGUMENTS` handling; do not leave Pi to infer an unreplaced placeholder. Browser review remains external. | Low / 1 |
| [`prototype`](../harness/planning/prototype/harness.toml) | Yes / S | Same throwaway branch/logic/UI workflow and supporting guides. Available browser tools determine UI verification depth. No automatic prototype delegation: current interactive-only constraint stays. | Low / 1 |
| [`read-all-adrs`](../harness/planning/read-all-adrs/harness.toml) | Yes / S | Same exhaustive Markdown read. Large ADR inventories still consume model context and may need appropriate context capacity. | Low / 1 |
| [`websearch`](../harness/planning/websearch/harness.toml) | Yes / S, capability-qualified | Context7 CLI and trusted-source index transfer. Pi's default four tools do not include a built-in web-search service. Supply a configured search/MCP/extension or verified CLI route for the fallback search requirement; lack of it is a reported coverage gap, not fabricated search. | Low skill; external tool setup / 1 |
| [`writing-adrs`](../harness/planning/writing-adrs/harness.toml) | Yes / S | Same durable decision-document rules; no native provider behavior required. | Low / 1 |

### Productivity — 17 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`agent-launcher`](../harness/productivity/agent-launcher/harness.toml) | Yes / P | Add Pi wrapper/entry point, command/config validation and prompt arguments to existing Python launcher abstraction. `--system-prompt` and `--append-system-prompt` exist, but Pi does not document Claude's arbitrary per-run `--settings` file interface. Map supported flags or use an explicit native extension; do not isolate the entire agent directory and accidentally lose auth/skills. Existing Claude-only prompt skill remains Claude-only. | Medium / 1 |
| [`caveman`](../harness/productivity/caveman/harness.toml) | Yes / S | Same response-style skill. Portability does not verify the manifest's token-savings claim. Persistence remains instruction-driven, subject to compaction. | Low / 1 |
| [`cleanup-git`](../harness/productivity/cleanup-git/harness.toml) | Yes / E | Read-only inventory script and approval rules transfer. Native skill wrapper/input preparation injects the inventory before the model; preserve fallback reads, missing `gh` behavior and protected-branch/worktree rules. Never turn inspection into automatic cleanup. | Low–medium / 1 |
| [`decisions`](../harness/productivity/decisions/harness.toml) | Yes / S | Same retrospective confidence review within the available conversation. | Low / 1 |
| [`enable-desktop-notification`](../harness/productivity/enable-desktop-notification/harness.toml) | Yes / E | Native enable/disable command and session-persistent opt-in. `agent_settled` triggers existing OS notifier with Pi session name and final-text preview. Do not emit terminal escape notifications into RPC/JSON stdout; upstream notify example is precedent, not our full opt-in implementation. | Low–medium / 1 |
| [`handoff`](../harness/productivity/handoff/harness.toml) | Yes / S | Same redacted temporary handoff document. Pi's native compaction/handoff examples are optional enhancements, not a replacement for a user-requested artifact. | Low / 1 |
| [`handoff-grilling`](../harness/productivity/handoff-grilling/harness.toml) | Yes / S | Same detailed design conversation handoff; obey temporary-file and secret-redaction rules. | Low / 1 |
| [`mid-prompt-skills`](../harness/productivity/mid-prompt-skills/harness.toml) | Yes / E | Pi's native skill expansion checks a leading `/skill:` command. Implement later `/skill:name` mentions through `input` transform, using the resolved discovered skill set; skip fences, already expanded entries and unknown names. Preserve request text/images and avoid command recursion or double expansion. Support `/name` aliases only if deliberately registered. | Medium / 1 |
| [`next-decision`](../harness/productivity/next-decision/harness.toml) | Yes / S | Same forward-looking decision rounds, recommendation and explicit wait. | Low / 1 |
| [`report-gotchas`](../harness/productivity/report-gotchas/harness.toml) | Yes / E | Existing CLI, queue and Discord worker transfer. `tool_result` binds shell submission receipts to Pi session/cwd; extend provider labels instead of treating every non-ChatGPT report as Claude. Preserve receipt idempotency, no duplicate reports and configured-webhook behavior. | Low–medium / 1 |
| [`setup-command-aliases`](../harness/productivity/setup-command-aliases/harness.toml) | Yes / S | Same shell configuration preservation and activation workflow, including a future Pi wrapper alias. | Low / 1 |
| [`setup-text-replacements`](../harness/productivity/setup-text-replacements/harness.toml) | Yes on Windows / S | Same AutoHotkey edit/reload. Keep Windows-only scope; a Pi provider does not make this cross-platform. | Low / 1 |
| [`stop-overthinking`](../harness/productivity/stop-overthinking/harness.toml) | Yes / S | Same concise practical-decision skill. | Low / 1 |
| [`subagents`](../harness/productivity/subagents/harness.toml) | Yes / P | All launcher families, toolkit, normal/previous-message reply and `resume-agent`; persistent `run`, `ask`, `reply`, `resume`, `watch`; custom roles and loop backend. Reuse SQLite reservations, inbox/request/result protocol and visible launcher. Add Pi provider/model/effort validation, native child-skill invocation, binding, progress, branch-aware previous text, interrupted execution recovery, and stop/feedback continuation. | High / 2 |
| [`todo-hitl`](../harness/productivity/todo-hitl/harness.toml) | Yes / S | Both `mark-as-todo-hitl` and `address-todo-hitl` transfer unchanged; preserve agreement before remediation. | Low / 1 |
| [`writing-for-agents`](../harness/productivity/writing-for-agents/harness.toml) | Yes / S with reference update | Core writing guidance transfers. Extend `SKILL-MECHANICS.md` provider mechanics for `/skill:name`, Pi discovery and invocation policy; avoid presenting Claude-only frontmatter as universally executable. | Low / 1 |
| [`zoom-out`](../harness/productivity/zoom-out/harness.toml) | Yes / S | Same codebase abstraction-map skill. | Low / 1 |

### Extensions/apps — 2 packages

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`aboard`](../harness/extension/aboard/harness.toml) | Yes / P | Add Pi platform/launch/session/preflight/lifecycle/skill adapters, provider config and UI options, managed extension assets, worktree copying and resume support. Preserve visible terminals, leases, authenticated bridge, prompt receipt confirmation and Auto Run commit contracts. Read-only/safety capability checks must precede checkout creation. New VSIX release/pin is required to ship support. | High / 2 |
| [`auto`](../harness/extension/auto/harness.toml) | Yes / E, Aboard-dependent | Native `/auto` and `/auto --dry` call the existing authenticated Aboard endpoint without a model turn. Retain active-session requirement and explicit error when unavailable. Full workers depend on the Aboard Pi adapter and mandatory restrictions. | Low command; high dependency / 2 |

### Shipping — 1 package

| Package | Useful to Pi? / route | Implementation and parity requirements | Effort / priority |
| --- | --- | --- | --- |
| [`setup-help`](../harness/shipping/setup-help/harness.toml) | Yes / S | Same one-current-step plus complete remaining-checklist guidance. Useful for Pi installation/authentication/trust as well as project setup. | Low / 1 |

### Archived and unmanifested tools — 6 additional assessments

These are not active catalogue selections and should not be counted as implemented or newly installable.

| Tool / current status | Pi usefulness and feasible equivalent | Recommendation |
| --- | --- | --- |
| `improve-codebase-architecture` / archived manifest | Shared architecture analysis and design references are portable. Current `audit` covers the general assessment use case. | Technically low effort; leave archived unless explicitly reactivated. |
| `grill-me-in-lavish` / archived manifest | Python board core, Node Lavish bridge and extension event adapter could reproduce the visual interview. | Prefer active hosted `grill-me-in-cloud`; do not revive a second board backend merely for Pi. |
| `remove-anthropic-coauthor` / archived manifest | Solves Claude-specific automatic attribution, not generic Pi behavior. | Not applicable. If an installed Pi extension adds trailers, configure that extension instead. |
| `copy-message-as-issue` / archived, no manifest | Native command can read branch-correct previous assistant text and reuse GitHub publication code without a model call. | Feasible medium effort, but keep explicit approval and existing draft/publish workflow preferred. |
| `senior-advisor` / archived, no manifest | Pure read/reason skill transfers; read-only tool restriction could optionally enforce its advisory scope. | Low effort if revived; reconcile its automatic-trigger description with explicit-only frontmatter first. |
| `draft-audit-issues` / in progress, no manifest | Skill transfers once the issue-writers extension supplies draft paths and publishing/session context. | Finish its catalogue/package integration independently; Pi alone does not resolve its current invisibility. |

## Recommended implementation architecture

These catalogue-wide considerations informed the [extended architecture proposal](PI-ARCHITECTURE.md).
That proposal resolves initial packaging, dependency ownership, custom Pi roots, command routing,
and standalone hosted delivery; use its decisions for the first 35 packages. Persistent runtime,
`/ship`, and Aboard boundaries below describe later integration work.

### 1. Installer: add a real third platform, without changing persistent commands into installer actions

Extend `Platform`, adapter lookup, catalogue support declarations, CLI/TUI choices/defaults, support/replacement reporting and platform-related receipt/settings tests. Audit two-provider assumptions rather than adding an enum value and trusting `else` branches: several runtime and host paths currently mean “ChatGPT if not Claude.”

Suggested native roots:

| Logical destination | Project | User |
| --- | --- | --- |
| platform | `.pi` | `~/.pi/agent` |
| skills | `.pi/skills` | `~/.pi/agent/skills` |
| Pi extension entry points | `.pi/extensions` | `~/.pi/agent/extensions` |
| Python helpers, not auto-loaded extensions | `.pi/hooks` or an extension-local support directory | `~/.pi/agent/hooks` or an extension-local support directory |
| shared configuration | `.harness` | `~/.harness` / existing Harness state override |

Use shallow source `pi/` overlays for extension entry points/settings fragments, retaining shared Python cores and skills at package roots. Do not create `targets/`, mirror installed trees into overlays, or copy runtime source trees out of their real packages. Add an explicit extension destination capability or deliberately map extension payloads through the platform root; a generic `/hooks` mapping is not Pi extension discovery.

Conventional extension discovery can avoid configuration fragments for simple packages. When settings are necessary, implement Pi's resource-list/object semantics and receipt-driven removal; avoid changing `defaultTools` or model defaults as incidental install side effects. Honor `PI_CODING_AGENT_DIR` where relevant or document explicit supported root behavior. Never own/delete `auth.json`, `trust.json`, native sessions, or unrelated extensions.

Preserve starter files, dependency coupling, modified-file protection, overwrite/adopt approval, dry-run/JSON planning and multi-provider uninstall. Bump package versions only when their payload/fragment/action/support changes are actually shipped. The report/reference additions do not justify changing every package version now.

Pi CLI is a prerequisite, not automatically an npm host action. Current host-action parsing supports pinned `uv-tool` and VSIX actions, not arbitrary npm installs. If Harness later owns Pi installation itself, that requires a separately designed ownership/version/removal contract.

### 2. Extension bridge: small provider adapter, shared package cores

A common bridge should normalize:

- Pi `toolName`, `input.path`, `oldText`/`newText`, shell command, cwd, successful/error result, session ID/file, branch and tool-call ID.
- Python guard decisions into native deny reasons; additional model context into preserved tool-result/custom-message content; command status into user-visible output without another model turn.
- Structured argv/stdin subprocess calls, UTF-8, bounded output, timeouts and cancellation. Use the selected Python interpreter, not shell interpolation of user prompt text.

Keeping Python avoids TOML/parser/regex/shell-detection drift and preserves existing tests. One subprocess per matching event is a reasonable first bridge, but measure latency before claiming it is cheap. A long-lived worker is an optimization with reload/crash/state complexity, not a starting prerequisite.

Packages remain independent. If the bridge becomes a managed shared dependency, make that dependency explicit and versioned, rather than hiding it in Aboard or requiring an all-in-one extension. Load only each selected package's behavior. Do not package a full two-provider hook protocol emulation where a direct command/core call is simpler.

Critical adapter tests: unknown inputs, failed writes, Windows paths/encoding, overlapping policies, parallel tool calls, missing Python, malformed output, cancellation, reload and event composition. Guards fail closed where their contract requires it; informational nudges may report adapter errors without disguising successful writes as failures.

### 3. Commands and skill entry points: keep deterministic actions distinct

Native `/commit`, `/publish-issues`, `/approve-doc-draft`, `/reject-doc-draft`, `/enable-desktop-notification`, `/reply-to-agent-with-previous-message` and `/auto` should be extension commands. Normal workflow skills stay `/skill:name`.

For hook-backed workflow preparation, either wrap the short command and submit the resolved skill body/context, or handle the raw `/skill:name` in `input` before native expansion. Choose one route per command and test it. Registered commands run before `input`, and extension-sent user messages do not expand commands/templates by default; an assumption that one generic prompt hook sees all invocations will miss native commands.

Guard direct `/skill:publish-issues` and other deterministic-command fallback invocations as well as short aliases. Their current skills intentionally report interception failure; loading those bodies as normal Pi prompts would produce broken workflows. Aboard prompt receipt should be emitted by both the normal input path and relevant command handler, correlated to the actual tracked session, not inferred from keystrokes.

### 4. Persistent runtime and `/ship`: explicit Pi lifecycle state machine

Reuse durable reservations, requests, results, execution PID/birth checks and wait tokens. Extend provider validation in CLI/delegation/session/role discovery, launch configuration and telemetry. Avoid a hardcoded universal Pi model list: Pi selects a model **service plus model**, supports custom endpoints and allows switching mid-session. Harness `provider: pi` means the agent host; it is not Pi's internal `--provider` model-service name. A provider-qualified Pi model such as `service/model-id` is a suitable explicit override.

Native launch examples at the examined version:

```bash
# Visible, client-assigned identity; trust is a separate preflight decision
pi --session-id <new-id> --name agent-1 -- "/skill:address-this <task>"

# One-shot structured progress, persisted conversation
pi --mode json --session-id <new-id> -- "/skill:address-this <task>"

# Continue only after checking the exact saved conversation exists
pi --session <absolute-session-file> -- "<next message>"

# Carry context forward while the original live terminal remains untouched
pi --fork <absolute-session-file> --session-id <new-id> -- "<next message>"
```

These illustrate an adapter contract, not commands to run as part of this investigation. Use exact file/ID validation; `--continue` is not precise enough for an `agent-i` binding. Resolve project trust explicitly before automation; do not blanket persist trust for arbitrary repositories.

Parent waits and implementer feedback belong at `agent_before_settle`, not final notification. Return a custom-message entry plus a bounded continuation only when a real result or valid token-bound feedback exists. Skip success delivery on errors/abort; reconcile unfinished work on next session start. Handle timeout, lost lead, stale token, process exit, resumed/forked identity, duplicate result replay and user steering without launching another implementer prematurely.

Previous-message replies should use active-branch assistant text, not the last matching line anywhere in the JSONL. Context usage can come directly from `ctx.getContextUsage()` and the active model; preserve unknown values after compaction and for unsupported metadata rather than inventing percentages. `watch` needs Pi event summaries and provider usage fields; background success must inspect event semantics as described above.

The official [subagent example](PI-REFERENCES/examples/extensions/subagent/README.md) proves isolated-process dispatch, streaming and abort propagation are feasible. It does **not** provide Harness inboxes, cross-host delegation, interactive child reply ownership, durable resume, loop wait tokens, Aboard leases or recovery. Use it as transport precedent, not a wholesale replacement for the runtime.

### 5. Aboard and hosted Grill: adapters plus capability gates

Implement the existing `AgentPlatform` contract for Pi, provider configuration/effort handling, session binding/resumability, launch preflight and worker lifecycle. Extend contributed UI/provider choices and worktree configuration copying. The extension must rebind bridge session identity across `/new`, `/resume`, forks, reloads and compaction and cleanly end the old binding.

Retain Aboard's visible-terminal worker contract. RPC alone is headless and is not the same Pi TUI terminal; a terminal extension can expose authenticated inbound messages, or existing terminal submission can remain with provider receipt confirmation. A future RPC-rendered UI is a separate product choice.

Read-only explore can select `read,grep,find,ls`, but **that flag alone is insufficient**: MCP tools may remain callable, custom tools can mutate, and extensions can re-enable tools or execute directly. At minimum use controlled resource loading, explicitly exclude uncontrolled MCP/mutating tools, and load a mandatory restriction extension through an explicit path. If equivalent restrictions cannot be enforced for a configured launch, `requireEnforceableRestrictions` must refuse it before a checkout is created. Strong read-only isolation requires OS/container enforcement, not a prompt or tool name list.

Auto Run retains its current Git permissions and acceptance-commit observation; `/ship` implementers retain the stricter Lead-owned Git/GitHub mutations. Those are different policies, not one shared “allow commit” switch.

Grill additionally needs an additive database migration widening all provider check constraints, API route and Zod validation updates, protocol fixture updates, Pi title extraction, presence/delivery handling and Aboard relay support. Preserve publication idempotency, private assets, authenticated tokens, queued-answer semantics and confirmation only after Pi received the message. No deployment or database mutation is authorized by this report.

## Risks and non-equivalences

| Risk | Consequence | Required treatment |
| --- | --- | --- |
| Same-user extensions are trusted executable code | Guard callbacks cannot contain hostile extensions or arbitrary scripts. | Explicit trust boundary, controlled automation resources and OS isolation where required. Never call the bridge a sandbox. |
| Untrusted project resources skipped in headless mode | Skills/guards can appear installed but not load. | Preflight trust and verify required extensions/skills actually loaded; abort mandatory-policy runs otherwise. |
| Native skill/command discovery overlaps `.agents` | ChatGPT-installed hook-only fallback skills can surface in Pi before support exists. | Collision tests, clear unsupported diagnostics, deterministic-command interception and independent receipt ownership. |
| Parallel/nested calls and other extensions' transformations | Read state or pre/post snapshots can attribute the wrong call/file. | Per-call state, queues for read-modify-write, tested handler ordering, nested-call accounting and success-only attribution. |
| Session trees and model switching | Flat transcript scans include abandoned work or stale model capacity. | Active-branch reconstruction and actual selected-model telemetry. |
| `agent_end` mistaken for completion | Premature notification, reply or worker advancement before retries. | Final settlement for notification; actionable pre-settle boundary for continuation. |
| Zero JSON process exit with failed model response | False successful child/worker result. | Inspect final messages, stop reasons, abort/retry status and settlement. |
| Web/browser availability inferred from model name | Research/UI tests silently lose capabilities. | Explicit capability preflight and honest verification gaps. |
| Quota read from Claude/Codex credentials unrelated to Pi | Waits on the wrong account/backend or leaks credentials. | Backend-specific opt-in readers, account binding, fail-open read failures; never copy credential files. |
| New upstream namespace/API | Legacy examples compile against the wrong imports or lack boundary events. | Validate installed version/exports/help; establish a tested runtime baseline distinct from the rolling documentation mirror. |

## Delivery sequence and verification gates

The [first-release delivery plan](PI-ARCHITECTURE.md#delivery-plan-and-acceptance-gates) is the
current proposal for the requested tools. The phases below retain the broader investigation's
path to complete provider parity; they do not add tools to the initial scope or require Aboard
before `grill-me-in-cloud`.

### Phase 1 — Installation and shared skills

Add Pi platform/layout, manifest declarations and shared payload mappings, invocation documentation and discovery/trust preflight. Include `lavish` portability and writing-for-agents mechanics updates. Prove project/user install, upgrade, modified/starter preservation, cross-provider collision/uninstall, dependencies and dry-run receipts. Gate: all advertised skills actually discoverable in a trusted real Pi session; user-only skills remain unavailable to implicit selection.

### Phase 2 — Guard and command extensions

Build the reusable bridge, then command-guard, read/edit nudges and guidance guards, no-new-documents, issue workflows, cleanup, notifications, report-gotchas and session-scoped commit. Gate: denied calls have zero mutation; informational rules preserve successful results; deterministic commands generate **zero inference requests**, including errors and dry runs.

### Phase 3 — Persistent Pi delegation and ship

Add exact session identity, launch/resume/fork, progress/success parsers, parent delivery, previous-message reply, custom roles and loop lifecycle. Gate: cross-host delegation in both directions, warm-context feedback, interrupted-child resume, live-fork behavior, durable result replay, token invalidation and one implementer per worktree. `/ship` scenarios must satisfy existing acceptance contracts unchanged.

### Phase 4 — Aboard, hosted board and release

Add Pi adapter, visible terminals, worker restrictions, auto command, provider config/UI, prompt receipt and Grill protocol/database migration. Gate: interactive takeover, correct lifecycle binding, no false successful worker, AFK/HITL commit contracts, denied original-checkout mutations and correct board answer receipt. Publish a new pinned VSIX/runtime release only after explicit release authorization.

### Phase 5 — Optional quota and ergonomics

Prototype one clearly identified quota backend if demanded; add native custom UI where it improves the same tool contract. Keep redirect-subagents unsupported on Pi and archived tools archived. Core support must not depend on quota scraping or adopting third-party extensions.

### Deterministic E2E approach

Extend the shared real-CLI infrastructure with a Pi launcher, not a simulated Pi hook runner. Use isolated `PI_CODING_AGENT_DIR`, temporary external sessions/projects, `--offline`, explicit tested resources and a local compatible model endpoint configured through Pi's supported model registry/custom provider path. Clear inherited API/OAuth/cloud credentials and model-service selectors; disable retry/cache-warming/nonessential traffic. Use a dummy per-run bearer, loopback-only binding, no forwarding, strict unknown-history rejection and structural redacted diagnostics.

An existing Anthropic/OpenAI inference server may be reusable **if its wire contract matches the selected Pi backend**; prove that in a compatibility test instead of assuming identical request/history shapes. Keep the real CLI, tools, extensions, filesystem and runtime active. Assert observable results, denial effects, lifecycle/schema events and zero unexpected requests—not agent prompt wording.

Test matrix must include Windows/POSIX, TUI/JSON/RPC where relevant, session start/reload/switch/fork/compact, failed and aborted turns, parallel calls, MCP/codemode paths, malformed policies, no Python, no bridge, stale wait tokens and vanished transcripts. Existing Claude/ChatGPT journeys must remain unchanged and passing. Read-only safety and mandatory-extension admission tests are release gates, not later cleanup.

## Documentation synchronization delivered

- Added [`docs/PI-REFERENCES`](PI-REFERENCES/README.md): **50 mirrored files** comprising the official agent overview, package metadata, MIT license, 34 integration-relevant documentation pages, 12 selected extension/example files and exported extension API declarations.
- Kept upstream text unmodified. This is a curated reference set, not an executable Pi checkout; some links reach unmirrored upstream material.
- Extended `scripts/update_references.py` bootstrap sources and added a machine-readable local source index. Canonical raw GitHub sources track `main`, following the existing rolling-mirror model.
- Extended the existing daily 06:00 UTC/manual GitHub Actions workflow to fetch and stage Pi alongside Claude and ChatGPT. Increased job timeout for the larger reference set. Fetch failures remain errors, so the commit step does not run after a failed refresh.
- Added updater/index/workflow coverage, including failed/empty-source preservation. Actual GitHub Actions execution and remote commit/push require the changes to land upstream; no workflow was dispatched or changes published during this task.

The updater can write successfully fetched files before reporting another source's failure, as it already does for the other providers. This is not an atomic multi-file snapshot. The workflow will not commit that failed run; local users should inspect/retry failures. Upstream file moves are intentionally surfaced as failures, not silently replaced with stale fallback sources.

## Verification and remaining uncertainty

Completed in this investigation:

- Live retrieval of the Pi mirror and confirmation of canonical repository/package identity.
- Catalogue discovery: 48 active packages, 47 selectable; active matrix covers each exactly once. Checked report links and all 50 indexed mirrors for existence and nonempty content; a canonical-source refresh completed successfully.
- `uv run pytest tests/unit/test_update_references.py -q`: **10 passed**.
- `uv run pytest -q`: **1508 passed**.

Not performed: Pi installation, executing proposed extensions or model turns, model-service quota experiments, real-CLI Pi E2E, Aboard/Grill modifications, remote workflow execution, publishing or deployment. Documentation-level feasibility is high for shared skills and direct extension APIs; persistent lifecycle/restriction parity must be established by the phase gates above. No report claim should be read as runtime certification of Pi 1.2.0.

**Decision-ready result:** Pi is a viable third host with substantial reuse. Approve the installer/skills/extension foundation first; require explicit safety and persistent-session evidence before advertising full subagents, `/ship`, or Aboard parity.
