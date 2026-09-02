# Claude Code and Codex support audit

Audit date: 2026-09-03. Repository examined: `64056a7`. Local executable examined: `codex-cli 0.152.1`.

**Conclusion: aboard can plausibly support both runtimes without replacing its orchestration architecture. This is a medium-to-large refactor, with several compatibility gates. Exact feature parity is not established by documentation alone.** Launching a Codex terminal is easy; preserving role restrictions, reports, human takeover, recovery, and isolated configuration is the substantial work.

Scope is local Codex sessions, including ChatGPT-authenticated sessions, in real VS Code terminals. It does not assume the ChatGPT website or desktop application's tools are available inside an independently launched CLI.

This audit inspected runtime boundaries, scaffold definitions, and focused tests; read the supplied official snapshots under `C:/Users/emb/Desktop/dev/projects/harness/docs/CHATGPT-REFERENCES`; fetched current official documentation; and inspected local CLI help and generated protocol schemas. It did not launch agent conversations, exercise an aboard workflow, change settings, or create GitHub state. Runtime feasibility gates below remain untested.

## What can remain shared

The existing separation is useful. Keep one fleet, one write lease, one bridge, and one auto-run engine across Claude and Codex. A Claude Manager should be able to delegate a Codex worker and receive its result, and vice versa.

Most of `src/git/`, `src/github/`, and the frozen-plan, validation, journal, cleanup, and lease logic in `src/domain/` can remain shared. Auto-run orchestration already consumes an `AutoRunLauncher` interface in `src/auto/engine.ts:87`. Its launch inputs and worker results need adaptation, but GitHub admission, disposition, dependencies, commits, reviews, merges, and issue closure do not depend on the model provider.

The bridge authentication, role catalog, initialization gate, `/commands` credential separation, native views, and human approval decisions also remain extension responsibilities. Supporting another agent must not move those decisions into prompts.

There is nevertheless real coupling outside `src/claude/`: delegation imports the Claude planner and transcript probe; domain capability derivation recognizes Claude tool names; persistence lacks a runtime discriminator; the auto-run prompt names Claude in Chrome; and worktree setup overlays only `.claude` and `.aboard` configuration.

## Capability assessment

“Supported” means the mechanism is documented, not that the aboard integration has been tested.

| Aboard requirement | Assessment | Consequence |
| --- | --- | --- |
| Independent, visible, interactive terminals | Supported | Use the Codex TUI through the existing VS Code terminal host. |
| Initial prompt supplied before automated work | Supported | CLI accepts an initial prompt; resume accepts a session and prompt. Replace Claude-specific prompt spill handling. |
| Long-lived Manager and exact-session resume | Supported, different identity model | Preserve a Codex thread identifier separately from aboard's launch identity. |
| ChatGPT account authentication | Supported | Reuse Codex's authentication flow; an API-key-only integration is unnecessary. |
| Private role instructions | Supported mechanism | Generate provider-specific instructions/configuration outside the repository. |
| Role-scoped aboard MCP | Supported | Translate registration to Codex configuration and retain bridge-side role checks. |
| Stop reports, startup briefing, compaction re-grounding | Supported primitives | Implement a Codex event/output adapter. |
| Completion versus failure while the TUI stays open | Requires additional integration | Prefer structured runtime events over process exit alone. |
| Manager cannot implement or spawn internal agents | Partly supported; policy gate | Internal subagents can be disabled; full effective tool restrictions need verification. |
| Automatic worker cannot mutate Git/GitHub workflows | Policy gate | Claude deny-rule strings are not portable. |
| `/done`, `/auto`, `/queue`, and other intercepted commands | Compatibility gate | Check Codex composer handling before relying on prompt hooks. |
| Isolated per-launch skills and hooks | Feasible design; isolation/trust gate | Do not install aboard assets into global/project discovery locations. |
| One write lease across providers | Supported by existing domain design | Derive capability from the provider's effective policy. |
| AFK and HITL auto-run, both branch modes | Feasible | Retain extension orchestration and explicit human acceptance. |
| Worktrees and Windows | Supported foundations; boundary tests needed | Translate filesystem policy, setup overlays, quoting, and process lifecycle. |
| Claude's built-in `Explore` | No literal equivalent top-level launch established | Define an explicit Codex exploration strategy; preserve Claude's existing builtin. |
| `[AI]-chrome` | No verified CLI-native equivalent | A browser MCP integration is a separate dependency and behavior choice. |
| Claude-shaped telemetry/transcript backups | Not portable unchanged | Provider-specific observation/history implementation; do not fabricate missing fields. |

CLI launch/resume and remote TUI connection are documented in [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli). ChatGPT and API-key authentication are documented in [Authentication](https://learn.chatgpt.com/docs/auth). Native Windows sandbox configuration is covered by [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic).

## Important refactor boundaries

### 1. Session identity and recovery — high difficulty

`src/claude/launch.ts:664` requires an aboard-minted UUID, imposed through `--session-id`. `src/claude/terminals.ts:223` exports it, while `assets/runtime/aboard_hook.py:199` prefers that environment value over the hook's actual identity. The local Codex CLI has no corresponding create-with-this-ID flag in its help.

Separate the aboard agent/launch ID from the runtime conversation reference. Record the returned Codex thread ID; use an explicit registration handshake for a CLI-only implementation. Reject stale events by launch generation and runtime identity. A Codex thread ID and its session-tree ID are distinct concepts, especially after forks.

Persist the provider in fleet, Manager, activity/reopen, and failed-worker records. Freeze provider/model/effort policy with auto-run settings so a later setting change cannot resume work through another runtime. Existing Claude records require an explicit migration. Cross-provider continuation should start a new conversation with a deliberate handoff, not feed a Claude identifier to Codex.

`src/claude/sessions.ts:17` derives a Claude project transcript path, and `src/claude/transcript-backup.ts` restores Claude files. Neither is a Codex history interface. The Codex adapter must report unavailable or unsupported histories accurately; current app-server documentation also describes limitations for paginated histories.

### 2. Role tools and write capability — highest-risk boundary

`src/domain/capability.ts:4` knows `Edit`, `Write`, and `NotebookEdit`; its shell recognition knows `Bash` and `PowerShell`. Feeding it a Codex tool list containing `apply_patch` or `exec_command` could incorrectly classify a writer as read-only. This is a concrete integration hazard, not a cosmetic naming issue.

Use a provider adapter to derive effective capabilities from the same resolved role definition that builds the launch. Unknown capabilities must be conservative. Do not add a separate manually maintained “writes” flag.

Codex configuration supports disabling internal agents and controlling shell availability, sandboxing, model instructions, and MCP exposure. The inspected public configuration and CLI help do not establish a general equivalent of Claude's whole-session `tools:` allowlist plus `--disallowedTools`. [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)

For a Codex Manager, disabling subagent tools and combining read-only filesystem policy with controlled tools is a credible direction. It still needs to support the Manager's legitimate planning/GitHub work. A prompt saying “do not implement” is insufficient. Do not assume a read-only filesystem policy restricts mutating remote MCP operations.

`src/auto/permissions.ts:1` contains extensive Claude-specific Git/GitHub denials. Codex execution rules govern commands outside the sandbox; they are not automatically a complete replacement for these denials. [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)

A provider-specific policy implementation needs tests for shell aliases, compound commands, PowerShell, nested code-mode calls, and MCP writes. Do not extend the worktree fence into a speculative shell-command security system. If native policy cannot meet the required contract, reduce the supported role scope or explicitly evaluate a deeper tool integration; do not silently weaken it.

### 3. Lifecycle and report delivery — medium/high difficulty

Codex documents startup, prompt, tool, compaction, subagent, and Stop hooks. Stop supplies the last assistant message and can request continuation. Its documented continuation uses `decision: "block"` and a reason that becomes a new prompt. The existing hook emits a different Stop context shape at `assets/runtime/aboard_hook.py:289`, so it needs translation. [Hooks](https://learn.chatgpt.com/docs/hooks)

Preserve the existing distinction between an unattended worker's result, an attended user's `/done`, a report owed to another session, an interrupted turn, and an exited process. Sending each final turn to the auto-run engine would incorrectly complete attended sessions.

The Codex hook reference does not list Claude's `StopFailure`; its PostCompact payload does not document `compact_summary`. `src/bridge/worker-hooks.ts` and `src/bridge/lifecycle.ts` cannot consume those Codex events unchanged. A worker may fail while its terminal process remains alive, so lock-file monitoring alone cannot settle that failure.

Test report delivery after Escape, multiple successive reports, cancellation during a foreground MCP call, and exactly-once completion. Also check whether unknown slash commands reach `UserPromptSubmit`: a hook cannot intercept input the TUI rejects first. Codex skills use `$skill` invocation; aboard's current slash commands need an explicit compatibility decision. [Build skills](https://learn.chatgpt.com/docs/build-skills)

### 4. Isolated configuration and hook trust — medium/high difficulty

`src/claude/spill.ts` creates a private `.claude` bundle and generated settings. Codex's `--add-dir` means additional writable directories, not Claude-style agent/settings discovery. Reusing that flag would not port the bundle.

Prefer per-session configuration and private generated assets. Codex's MCP registration supports HTTP URLs, bearer-token environment references, custom headers, and tool filtering. Use an environment token reference and an aboard agent-ID header; keep authorization in the bridge. Do not use persistent `codex mcp add` for ephemeral aboard registrations. [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)

Hooks from different configuration sources accumulate. Non-managed hooks require trust in their exact definition; untrusted hooks are skipped. Generated command paths that vary on every launch may complicate that trust. The documented trust-bypass flag is invocation-wide, not a trust grant for only aboard's hooks. Do not enable it by default over inherited user/project hooks. [Hooks](https://learn.chatgpt.com/docs/hooks)

Treat hook readiness as a launch precondition. Design explicit trust/setup or use structured events where possible. Hook errors are not a substitute for enforced permissions. Replacing `CODEX_HOME` casually would also change authentication, settings, and history locations; a temporary home needs a deliberate auth/history design. [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

### 5. Roles, models, browser, and scaffold — medium difficulty

Every scaffolded role currently says `command: claude`; most explicitly name Claude models. `src/claude/launch.ts:105` maps issue difficulty to Haiku/Sonnet/Opus. Changing only the global command setting cannot port these definitions.

Keep roles conceptually shared, with explicit provider-specific prompt/tool/model sections or files. Resolve difficulty independently per provider and validate supported effort against the selected model. Preserve “definition wins” and “unrated selects the most capable tier” semantics. Avoid mechanical model-name equivalences.

Rewrite references to `Skill`, Claude task tools, `LSP`, and Claude-specific interaction instructions. Codex's documented `explorer` is an internal subagent role; that does not establish an independently launchable replacement for Claude's `--agent Explore`. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The official browser-extension page describes access through the desktop application. It does not certify that an aboard-launched Codex CLI inherits those browser tools. A browser MCP setup is a plausible alternative, but signed-in-profile access, installation, permissions, and Windows behavior need separate validation. Retain `[AI]-chrome`; resolve it to an explicitly supported browser backend or refuse that launch with a clear explanation. [Browser extension](https://learn.chatgpt.com/docs/chrome-extension)

Extend worktree configuration overlays for the Codex files actually needed, preserving the ignored-only, no-links, no-overwrite rules. Revise the scaffold catalog and use the existing explicit upgrade flow. Do not invoke the general import feature to rewrite users' unrelated configuration.

## Integration direction

Introduce a small `AgentRuntime` boundary covering launch/resume preparation, effective capabilities, runtime identity, lifecycle/result observation, conversation availability, and cleanup. Keep terminal creation and domain services shared. Move the current Claude behavior behind it first; implement Codex separately. Avoid a universal schema for every tool either vendor might add.

Two approaches deserve comparison:

| Approach | Benefit | Limitation |
| --- | --- | --- |
| Codex TUI plus hook adapter | Closest to aboard's current process/terminal ownership | Trust setup, failure observation, transcript dependence, and command interception need solutions. |
| Codex app-server plus a real connected Codex TUI | Structured history, final/failed/interrupted turns, usage, and interruption | More lifecycle/transport code; terminal attachment, approvals, and policy persistence need proof. |

**Prefer evaluating app-server plus the native TUI for the complete integration.** App-server exposes start/resume/read and turn lifecycle operations; the native TUI can connect to it. Non-persistent extra skill roots are process-scoped, so a per-agent server is one possible isolation design. These are documented building blocks, not proof of aboard's full attachment flow. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Require the correct terminal to be attached before autonomous work begins. Keep the initial automated prompt in the CLI invocation if preserving today's launch contract; changing to RPC prompt delivery would require an explicit architectural decision. Distinguish server liveness from visible-terminal liveness, and terminate or interrupt owned work when admission closes. A headless server is not a fleet row the user can inspect.

The local 0.152.1 generated schemas include `baseInstructions`, `developerInstructions`, and per-thread `config` without experimental fields. Named permission profiles and dynamic tools appear only with experimental schema generation. The CLI itself still marks app-server tooling experimental. Pin and test a known version rather than declaring arbitrary Codex installations compatible.

## Effort and acceptance gates

Engineering estimate for one developer familiar with aboard, assuming native policy proves sufficient and no bespoke browser implementation: **20–33 engineering days, roughly 4–7 weeks**. This is an estimate, not measured delivery time.

| Stage | Estimate | Reviewable result |
| --- | --- | --- |
| Compatibility experiment in a throwaway repository | 2–4 days | Resolve terminal attachment, role policy, hook trust/commands, and failure events. |
| Extract shared runtime boundary and migrate identities | 4–6 days | Existing Claude behavior remains covered; provider-aware records and launch policy. |
| Codex terminals, lifecycle, private assets, and resume | 6–10 days | Manager and workers visible, resumable, and correctly isolated. |
| Mixed-provider auto-run, recovery, and worktrees | 5–8 days | Shared lease and journal, frozen provider settings, both review modes. |
| Scaffold/settings/UI, Windows validation, packaging | 3–5 days | Explicit upgrade, accurate UI, focused integration tests, packaging gate. |

The first stage should prove these concrete cases before committing to a full port:

1. A role-configured Codex conversation opens in its own VS Code terminal with its initial prompt, correct identity, and correct private aboard MCP catalog.
2. A Manager cannot edit application files or create internal agents, while its legitimate orchestration and planning tools work.
3. An implementer can edit and test but cannot perform the extension-owned Git/GitHub actions covered by the policy.
4. Successful, failed, and interrupted turns settle correctly while the TUI can remain open; attended sessions wait for `/done` or its agreed equivalent.
5. Manager reports survive Escape and later delivery; slash-command interception and hook trust work without broad trust bypasses.
6. Restart/resume retains provider, instructions, tools, model/effort, issue context, browser policy, and working directory; unsupported histories fail clearly.
7. Removing `.aboard/` closes admission and invalidates credentials; closing a terminal cannot leave invisible autonomous work running.
8. Mixed Claude/Codex workers contend for one write lease, and a crash cannot cause duplicate commit/PR/report actions.

Use existing launch, lifecycle, hook, reopen, permission, auto-engine, worktree, scaffold, and VS Code tests as contract coverage. New tests should verify equivalent product behavior through each adapter, not force Codex to emit Claude flags or payloads. Run end-to-end experiments only in a throwaway repository, as required by `AGENTS.md`.

The decision supported by this audit is to proceed with that bounded compatibility experiment. The evidence supports dual-runtime orchestration; it does not support promising unchanged Claude feature parity before the policy, trust, browser, and terminal gates pass.
