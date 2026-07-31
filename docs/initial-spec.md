# aboard — Project Specification

**Status:** Design complete, pre-implementation. This document is the authoritative starting point for scaffolding, agent-definition authoring, and all subsequent implementation work.

**Version:** 1.2 — the Manager's tool list moved from a runtime `toolPreset` setting passed as `--tools` on the command line into the `tools:` field of `.claude/agents/manager.md`, retiring the setting and the Manager's both-flags exception (§4.3, §5.1.1).

**Version:** 1.1 — incorporates the first full review pass. Changes from 1.0: the TODO moved from a committed file to a GitHub issue (§7.1); session-task tools removed from every Manager preset (§4.3); aboard no longer writes user permission settings (§4.3.1); the `SessionStart` injection cap and its split-hook mitigation (§4.5); `--agent` XOR `--tools` and the CLI-argument first prompt (§5.1); the raw agent as a first-class launch type (§5.7); prompt resolution before launch (§5.8); intercepted commands deny with exit 2 and batch notifications (§6.3); the `explorer` agent dropped in favour of the built-in `Explore` (§9.4); skill ownership clarified — most skills already exist and must not be reimplemented (§10.0); and hooks must self-guard because they are project-scoped, not agent-scoped (§3.4).

---

## 1. Purpose and Philosophy

### 1.1 What aboard is

**aboard** is a VS Code extension, tightly integrated with Claude Code, that replaces Claude Code's in-process sub-agent model with **real, independent Claude Code instances running in visible VS Code terminals**, orchestrated by a long-lived **Manager** agent, with **GitHub as the work-state backbone**.

### 1.2 Why it exists

Today, when Claude Code delegates to a sub-agent via the `Agent` tool, that sub-agent is opaque. It runs inside the parent process, in a context window you cannot see, and you learn what happened only from a summary it chooses to return. You cannot watch it work, cannot intervene when it goes wrong, cannot take over, and cannot resume it later.

aboard makes every delegated unit of work a **terminal you can watch, focus, take over, and resume.**

### 1.3 The goal is experience, not automation

**This is the single most important framing in this document, and it must not be eroded by later work.**

aboard is **not** an attempt to build a fully autonomous software factory. The goal is to **improve the user experience of building a real project with agents.** The human stays in the loop at every decision that matters. Automation is applied only where it removes tedium, never where it removes judgement.

Several design decisions in this document look conservative in isolation and are deliberate consequences of this principle:

| Decision | Autonomy-maximising alternative | Why we chose ours |
| :-- | :-- | :-- |
| Automatic review defaults to **off** | Auto-review everything | LLM API cost is real and the user decides where to spend it |
| `hitl` label gates chains on human action | Agents close their own work | The user chooses how far a chain runs unattended |
| **No parallelism, no worktrees** | Fan out N agents concurrently | Merge conflicts and self-contradicting agents destroy quality |
| Manager is read-only by default | Manager fixes small things itself | Keeps the Manager an orchestrator, not a drifting implementer |
| Interactive agents expect no result | Everything returns structured output | Some work is a conversation with the user, not a task |
| **The raw agent** (§5.7) — plain Claude Code, no workflow | Every task must enter the issue pipeline | The user must never be worse off for having installed aboard |
| aboard never writes user permission settings | Extension configures the workspace for you | The user's config is theirs; we add hooks and nothing else |

**Directive to future implementers:** do not "improve" aboard by making it more autonomous. If a change reduces the user's visibility or removes a decision point, it is a regression regardless of how much time it saves.

### 1.4 Design principles

1. **Visibility over efficiency.** If a choice trades observability for speed or tokens, observability wins.
2. **Structure over instruction.** Where an invariant can be enforced by the architecture (tool lists, leases, capability derivation), enforce it there. Prompt instructions are a last resort because models drift.
3. **Derive, don't duplicate.** Never store a fact that can be computed from an existing source of truth. Every duplicated fact is a future sync bug.
4. **GitHub is the durable state.** Agent context windows are volatile and lossy. Anything that must survive compaction, session loss, or a closed laptop lives in GitHub or in a committed file.
5. **The bridge is the only door.** Every agent in the system is created by the bridge. An agent not created by the bridge is outside the system by design, not partially registered.
6. **Cheapest sufficient mechanism.** A hook beats a tool call. A tool call beats a reasoning turn. A reasoning turn beats a whole agent.

---

## 2. Terminology

| Term | Meaning |
| :-- | :-- |
| **Bridge** | HTTP + MCP server running in-process in the VS Code extension host. The sole creator of agents. |
| **Manager** | The single long-lived Claude Code session the user converses with. Orchestrates; does not implement. |
| **Worker** | An independent `claude` process in its own VS Code terminal, created by the bridge. |
| **Automated worker** | A worker that performs a task and returns a result to the Manager. |
| **Interactive worker** | A worker the user talks to directly. Returns no structured result. |
| **Raw agent** | An interactive worker with no agent definition — plain Claude Code, tracked by the bridge but bound to no workflow (§5.7). |
| **Sub-sub-agent** | A built-in Claude Code `Agent`-tool sub-agent spawned *inside* a worker. No terminal. Visible in the tree via hooks. |
| **Fleet** | The set of all live agents known to the bridge. |
| **Write lease** | The single-writer token held by at most one write-capable agent at a time. |
| **Spec issue** | A GitHub issue labelled `spec`. The implementation contract for a feature. |
| **Implementation issue** | A leaf GitHub issue derived from a spec issue, sized for exactly one agent. |
| **TODO issue** | The single GitHub issue labelled `todo`. The project roadmap (§7.1). |
| **Prompt resolution** | The bridge assembling everything a worker needs into its launch prompt, before launch (§5.8). |

---

## 3. System Architecture

### 3.1 Component overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (TypeScript)                                  │
│                                                                      │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Fleet TreeView │  │ Status Bar       │  │ Commands             │ │
│  │ Manager        │  │ lease holder,    │  │ Start/Resume Manager │ │
│  │ ├─ worker      │  │ bridge port      │  │ Scaffold, Review PR  │ │
│  │ │  └─ subagent │  └──────────────────┘  └──────────────────────┘ │
│  └────────────────┘                                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ BRIDGE (127.0.0.1:<port>, token-authed, loopback only)         │ │
│  │                                                                │ │
│  │  MCP endpoint  /mcp        → aboard__* tools for the Manager    │ │
│  │  Hook endpoint /hooks/*    → callbacks from every agent         │ │
│  │  Control API   /terminals  → terminal lifecycle (from prototype)│ │
│  │                                                                │ │
│  │  State: fleet registry · write lease · result mailboxes ·      │ │
│  │         event log · session-id ledger                          │ │
│  └────────────────────────────────────────────────────────────────┘ │
└───────────┬──────────────────────────────────────────────────────────┘
            │ creates terminals, injects env
            ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌──────────────┐
│ Terminal: MANAGER     │  │ Terminal: worker #1   │  │ Terminal: …  │
│ claude --agent manager│  │ claude --agent impl … │  │              │
│                       │  │   └─ sub-sub-agents   │  │              │
└───────────────────────┘  └───────────────────────┘  └──────────────┘
            │                          │
            └──────────┬───────────────┘
                       ▼
              ┌─────────────────┐
              │ GitHub (gh CLI) │  spec issues · impl issues · PRs · review comments
              └─────────────────┘
```

### 3.2 The bridge

The bridge is the heart of the system. It runs **in-process in the extension host** — not as a separate process — so it shares the extension's lifecycle, has direct access to the VS Code API for terminal creation, and needs no IPC layer.

**Responsibilities:**

1. Create and track terminals (grown from the `"C:\Users\emb\Desktop\dev\prototypes\board-terminal-bridge1"` prototype).
2. Expose the `aboard__*` MCP tool surface to the Manager.
3. Receive hook callbacks from every agent in the system.
4. Hold the write lease and enforce single-writer.
5. Mint and record session IDs.
6. Hold result mailboxes for backgrounded workers.
7. Serve as the long-poll endpoint for the Manager's `Stop` hook.
8. Drive the TreeView and status bar.

**Binding and security:**

- Binds `127.0.0.1` only. Never `0.0.0.0`.
- Every request requires `Authorization: Bearer <token>`.
- The token is generated per extension-activation (a v4 UUID), held in memory, and written to `.aboard/runtime/bridge.json` (gitignored) for hook scripts to read.
- Port is chosen dynamically from an ephemeral range, with a configurable preferred port (`aboard.bridge.port`, default `4823`). Multiple VS Code windows therefore coexist.

**The token invariant:** an agent not launched by the bridge has no token and cannot participate. A `claude` session the user starts by hand in a plain terminal is simply *outside* the system — it is not a half-registered ghost in the fleet view. This is a feature, not a limitation: it means fleet state is always exactly what the bridge created.

### 3.3 Environment injection

Because the bridge creates every terminal, it controls every agent's environment. Each terminal receives:

| Variable | Purpose |
| :-- | :-- |
| `ABOARD_BRIDGE_PORT` | Port discovery — resolves the multi-window problem |
| `ABOARD_BRIDGE_TOKEN` | Auth — never committed, never in the repo |
| `ABOARD_AGENT_ID` | Identity — every hook callback self-identifies |
| `ABOARD_SESSION_ID` | The imposed Claude Code session ID |
| `ABOARD_AGENT_TYPE` | Agent type name, for hook routing |
| `ABOARD_ISSUE_NUMBER` | Set when the worker is bound to an implementation issue |
| `ABOARD_WORKSPACE_ROOT` | Absolute path to the workspace root |

Hook processes **inherit the parent environment** (confirmed in `docs/CLAUDE-REFERENCES/hooks.md`). This is the mechanism that makes correlation trivial: every hook callback carries `ABOARD_AGENT_ID`, so the bridge never needs PID matching, transcript-path parsing, or heuristics to know who is calling.

### 3.4 Hooks are project-scoped — every hook must self-guard

**This is the single easiest way to build a broken version of aboard, so it is stated before any hook is specified.**

Claude Code hooks registered in `.claude/settings.json` are **project-scoped, not agent-scoped.** They fire for *every* Claude Code session running in that workspace — the Manager, every worker, and any session the user starts by hand in a plain terminal, whether or not aboard created it.

That is a serious problem for a design in which hooks carry meaning:

- The Manager's `Stop` hook long-polls the bridge for background results (§6.4). If it fired inside an implementer, that implementer would refuse to stop, and the lease would never release.
- The `UserPromptSubmit` command interceptor (§6.3) exists for the Manager's terminal. If it fired inside a brainstormer, the user's `/brainstorm` would be swallowed in the wrong place.
- The briefing (§4.5) is written for an orchestrator. Injecting it into an implementer wastes context on state that agent must not act on.
- The compaction re-grounding hook (§8.4) tells a worker which issue it is implementing. In the Manager it is nonsense.

**Every aboard hook script must therefore begin by deciding whether this invocation is for it, and silently exit 0 if not.**

Three identity sources, in order of preference:

| Source | Availability | Notes |
| :-- | :-- | :-- |
| **`ABOARD_AGENT_ID` / `ABOARD_AGENT_TYPE` env** | Every bridge-created session (§3.3) | **Primary.** Present because the bridge injected it. Absent ⇒ not an aboard session ⇒ exit immediately. |
| **`session_id` from hook stdin** | Every hook event | Cross-check against the bridge's session ledger. Authoritative but costs a round-trip. |
| **`agent_type` from hook stdin** | `SessionStart` (`hooks.md:958`, present when launched with `--agent <name>`) and `SubagentStart`/`SubagentStop` (`hooks.md:2003`) | Useful, but **not available on every event**, so it cannot be the only guard. |

The canonical guard, at the top of every hook script:

```python
import os, sys

def guard(expected_types: set[str] | None = None):
    """Exit silently unless this hook invocation belongs to an aboard agent
    of the expected type. Hooks are project-scoped: they fire in every
    Claude Code session in this workspace, including ones aboard did not
    create. Exiting 0 with no output is a no-op for every hook event."""
    agent_id = os.environ.get("ABOARD_AGENT_ID")
    agent_type = os.environ.get("ABOARD_AGENT_TYPE")
    if not agent_id:
        sys.exit(0)                      # not an aboard session at all
    if expected_types and agent_type not in expected_types:
        sys.exit(0)                      # aboard session, wrong role
    return agent_id, agent_type
```

**Why exit 0 and print nothing:** it is a no-op on every hook event. Exit 2 would block, and on `UserPromptSubmit` it would erase the user's prompt (`hooks.md:703`) in a session that has nothing to do with aboard — turning a scoping bug into data loss. Printing anything at all would inject stray context into an unrelated agent. **Silence is the only correct failure mode for a hook that is not addressed to itself.**

**Corollaries:**

- A user's hand-started `claude` in this workspace has no `ABOARD_*` variables, so every aboard hook no-ops in it. The token invariant (§3.2) and this guard are the same idea applied at two layers: **sessions the bridge did not create are unaffected by aboard, in both directions.**
- Hooks that legitimately apply to *all* aboard agents (result reporting, compaction logging) still guard on `ABOARD_AGENT_ID` — they just pass no `expected_types`.
- The guard is **not** a place for cleverness. Any hook that cannot determine who it is must exit, not guess.

This also allows `.mcp.json` to be **committed with no secrets in it**:

```jsonc
{
  "mcpServers": {
    "aboard": {
      "type": "http",
      "url": "http://127.0.0.1:${ABOARD_BRIDGE_PORT}/mcp",
      "headers": { "Authorization": "Bearer ${ABOARD_BRIDGE_TOKEN}" }
    }
  }
}
```

---

## 4. The Manager

### 4.1 Nature

The Manager is **one long-lived Claude Code session**, running in its own VS Code terminal, and it is where essentially all high-level conversation with the user happens.

### 4.2 The Manager never implements

The Manager must never write code and must never spend time deeply reasoning about individual features. It delegates.

Rationale: a Manager that reads a 2,000-line file has spent its context on detail it will lose at the next compaction, and a Manager that reasons deeply about one feature has stopped being able to reason about the project. Its value is breadth and continuity, and both are destroyed by depth.

This is enforced **structurally** (the tool list, §4.3) and **by prompt** (§9.1), because the read-only tool list cannot fully prevent deep reasoning — only deep *writing*.

### 4.3 The Manager's tool list

The Manager's **persona** is a scaffolded agent definition, `.claude/agents/manager.md`, launched with `--agent manager` (§9.1). Like every other aboard agent, its **tool set is that file's `tools:` field**, and the launch command carries no `--tools` (§5.1.1). The shipped list is the read-only set:

```
mcp__aboard__*, Read, Grep, Glob, Bash, Skill, AskUserQuestion
```

The user tightens or loosens it by editing the file; the scaffolder preserves locally edited assets, so the change survives upgrades (a Manager restart is still required — the tool set is resolved at launch). An earlier draft kept the list in a `toolPreset` setting with two presets; that was retired in favour of one tool authority per agent, the definition file.

**Critical:** `Agent` is **absent from the tool list**, not merely denied. A `tools:` allowlist controls what enters Claude's context, rather than `--disallowedTools` (which only auto-denies). The distinction matters twice: the Manager cannot reach for a tool it cannot see, and we do not pay context for the `Agent` tool's schema.

**No task tools.** `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` (and the deprecated `TodoWrite`) are **deliberately excluded from the list.** Those tools exist to keep an agent on track through a long *coding* task, which is exactly the work the Manager never does. They would also invite a category error: an agent reaching for `TaskUpdate` to edit the project's global TODO. That TODO is a different artifact with a different lifetime, it lives in GitHub (§7.1), and it is edited through dedicated MCP tools (§6.2). The two must never be confused, and the cheapest way to guarantee that is for the session-task tools not to exist in the Manager's context at all.

### 4.3.1 aboard never writes user permission settings

**The extension must not write a `permissions` block into `.claude/settings.json`.** This was a mistake in an earlier draft of this spec and is now a hard rule.

Two reasons, both about user experience:

1. **It collides with the user's own settings.** `.claude/settings.json` is a file the user owns and edits. An extension that writes `permissions` into it either clobbers the user's rules or leaves them fighting a file that keeps changing under them.
2. **It is not scoped to one agent.** Project settings apply to **every** Claude Code session in the workspace — the Manager, all workers, and any session the user starts by hand outside aboard entirely. Scoping the *Manager* to read-only via project permissions would silently cripple the implementer too.

**The only thing aboard writes into `.claude/settings.json` is hook registration** (§10.3), which is additive, aboard-specific, and does not change what the user is allowed to do.

**Per-agent restriction uses `--disallowedTools` at launch instead**, which takes the same `ToolName(specifier)` rule format documented in `tools-reference.md` and applies to exactly one process:

```
claude --agent manager \
       --disallowedTools "Bash(git push*)" "Bash(git commit*)" "Bash(git merge*)" ...
```

**Two consequences to keep in view:**

1. **`Bash` remains a write vector in the read-only list.** A Manager with unscoped `Bash` can write files regardless of lacking `Edit`/`Write`. The read-only property is only as real as the `--disallowedTools` list at launch. That list is a setting (`aboard.manager.disallowedTools`), starts empty, and the user tightens it after observing actual behaviour.
2. **`Read` is path-scopable if wanted.** Per `tools-reference.md`, the `Read(path/**)` rule format applies to `Read`, `Grep`, `Glob`, and `LSP`, so `--disallowedTools "Read(./src/**)"` is expressible. Not used by default.

### 4.4 Lifecycle: one Manager, kept alive

**The Manager is long-lived.** Resume is the default path; a fresh Manager is an explicit choice.

- **`Aboard: Start Manager`** — mints a session ID, records it in `.aboard/runtime/manager.json`, creates the terminal, launches `claude --session-id <uuid> --agent manager`.
- **`Aboard: Resume Manager`** — relaunches with `--resume <recorded-uuid>`. This is what the extension offers by default when a recorded Manager session exists.
- **`Aboard: New Manager`** — explicit fresh start, replaces the recorded session ID.

**Context management: `/compact`, not restart.** When the Manager's context fills, the correct action is compaction, not a new session. Restarting is cheaper in tokens but loses conversational continuity, which is precisely the Manager's value. Auto-compact (§8.4) handles this without user action.

Because the Manager persists across VS Code restarts, the `SessionStart` briefing is primarily a **cold-start and re-orientation** mechanism rather than a per-open cost.

### 4.5 The briefing

On `SessionStart`, hooks inject the current project state so the Manager opens with an accurate picture and an actionable recommendation. Assembled by the bridge (which already knows fleet state) plus `gh` and `git`:

1. **Git state** — current branch, last N commits, dirty/clean.
2. **GitHub state** — open `spec` issues; ready implementation issues (all dependencies closed); open PRs and their review state; `hitl` issues awaiting the user.
3. **Fleet state** — live agents, their types, their issues, lease holder.
4. **Global TODO** — a **pointer**, not the content (see below).
5. **Unreviewed merges** — count of PRs merged without review since last session. One `gh` call, zero LLM tokens. Tells the user where a review would be worth spending, without ever spending one for them.
6. **Recommendation** — the Manager's synthesis of what to do next.

#### The injection budget

**Hook output strings are capped at 10,000 characters** (`hooks.md:758`), including `additionalContext`, `systemMessage`, and plain stdout. Output beyond the cap is written to a file and replaced with a preview and the file path — the same handling large tool results get.

That cap is generous, but it is not a target. A briefing that approaches it has already failed on cost: **every character of it is paid on every session start and every resume**, and most of it will be irrelevant to whatever the user actually wants to do. Two mechanisms keep it small:

**1. Split across multiple `SessionStart` hooks.** Per `hooks.md:838`, when several hooks return context for the same event, Claude receives **all** of the values. The budget is therefore per-hook, not per-event. aboard registers the briefing as separate, independently-truncatable hooks:

| Hook | Contents |
| :-- | :-- |
| `brief-git` | Branch, HEAD, dirty/clean |
| `brief-github` | Ready issues, open PRs, `hitl` waiting, unreviewed-merge count |
| `brief-fleet` | Live agents, lease holder |
| `brief-todo` | TODO **pointer** only |

The reason to split is **fault isolation, not headroom**: a `gh` call that hangs, errors, or returns something unexpected degrades one slice of the briefing instead of losing all of it. Each hook is independently timeoutable and independently debuggable.

**2. Reference, never inline.** No hook embeds a body of text it could instead point at. The TODO briefing hook emits a line like:

> Project TODO is issue #12. Read it with `aboard__get_todo` when you need it.

The Manager fetches on demand, which means a long TODO costs nothing at session start and costs exactly once when it is actually relevant. The same rule applies to spec issue bodies, PR descriptions, and review threads: **the briefing carries identifiers and counts, never content.**

#### The `--resume` replay hazard

`hooks.md:850` documents that mid-session injected context is **replayed, not re-run**, on `--resume`: values like timestamps and commit SHAs become stale. `SessionStart` hooks, by contrast, *do* re-run on resume with `source: "resume"`.

Therefore:

- **`SessionStart` is the authority on state.** It re-runs and can always refresh.
- **Mid-turn injections must be self-dating.** Any context injected by `UserPromptSubmit` or `Stop` must carry an explicit timestamp and be phrased as a point-in-time event ("at 14:32, worker X finished") rather than as standing truth ("worker X is running"), so a replayed injection reads as history rather than as a false present.

---

## 5. Workers

### 5.1 Launch

Every worker is an independent process, launched via `sendText()` into a freshly created VS Code terminal with the injected environment from §3.3.

**Terminals are created with `window.createTerminal()`** — a real PTY (conpty on Windows). This is a deliberate rejection of `vscode.Pseudoterminal`, which cannot emulate ANSI alternate screen buffers, cursor addressing, mouse reporting, or SIGWINCH; a real TUI renders garbled inside it. Claude Code is a real TUI.

#### 5.1.1 An agent's tools come from its definition — `--agent` and `--tools` never mix

**This is a CLI constraint and it shapes the whole launch layer.**

When `--agent <name>` is passed, Claude Code reads `.claude/agents/<name>.md` and takes the system prompt, the `tools:` allowlist, and the model **from that file's frontmatter.** Passing `--tools` alongside it is not the composition it looks like: the flag competes with the file the write lease (§8.1) reads to derive capability. aboard therefore never combines them — every aboard agent declares its tool set in its definition, including the Manager, and no launch command carries both flags.

> **Amended (v1.2).** The Manager used to be the one exception: its definition declared no `tools:`, so a runtime `toolPreset` setting could narrow the inherited pool via `--tools <preset>`. That made the Manager's tool authority unlike every other agent's and split the answer to "what can this agent run?" across a file and a setting. The setting and the exception are gone; `.claude/agents/manager.md` declares the read-only list like any other definition.

So there are exactly two launch shapes, and each agent uses exactly one:

| Shape | Command | Configuration source |
| :-- | :-- | :-- |
| **Agent-defined** (Manager and every worker type) | `claude --agent implementer --session-id <uuid>` | `.claude/agents/implementer.md` frontmatter |
| **Inline** (the raw agent of §5.7) | `claude --session-id <uuid> [--tools <list>]` | Launch flags |

> **Amended.** The inline shape carried an optional `--system-prompt <text>` and nothing ever set it: §9.7 defines raw as unconstrained, so there is no prompt to pass, and `raw` is the shape's only user. Supporting an option no caller could reach put an unbounded argument on every command line the planner has to fit inside a shell's length limit, so it is gone. `--tools` stays on this shape — with no definition to read, a restriction on a raw session has nowhere else to live.

**Consequence for the write lease.** §8.1 derives write-capability by reading the agent definition's `tools:` frontmatter. That derivation is only sound because agent-defined workers take their tools from exactly that file — there is no launch flag that can widen them behind the bridge's back. The mutual exclusion is what makes the derivation trustworthy rather than a guess. The inline shape is therefore **refused for every type but raw**, and the Manager never holds the lease (§8.1).

**Consequence for the Manager.** The Manager's prompt, model, and tool list all live in `.claude/agents/manager.md`, so the whole Manager definition is a versioned scaffold asset rather than an instruction in the user's `CLAUDE.md` — which would otherwise apply to every session in the workspace, including workers and hand-started sessions.

#### 5.1.2 The first prompt is a CLI argument

`claude` accepts an initial message as a positional argument:

```
claude --agent implementer --session-id <uuid> "Implement issue #47. <full body…>"
```

That message becomes the session's first user turn. **This is the only way aboard ever sends a first prompt.**

#### 5.1.3 aboard never types into an open TUI

**Hard rule: the extension starts or resumes `claude` sessions. It never writes into the prompt area of an already-running TUI.**

The reason is that what is on screen when a TUI opens is not under our control. Claude Code may show an update notice, a changelog, a new-feature callout, a trust prompt, or a onboarding screen that Anthropic added last week. Any of these swallows or mangles injected keystrokes, and a screen-scraper that tries to detect and dismiss them is a permanent maintenance liability that fails silently and at the worst moment.

Passing the message on the command line sidesteps all of it: the CLI receives the prompt as an argument before the TUI paints anything, so **the message is always delivered regardless of what the interface decides to show.**

`POST /terminals/:id/send` and `/keys` (§12) remain in the bridge, but strictly for **user takeover** — a human choosing to drive a terminal — never for programmatic prompt delivery.

#### 5.1.4 The Windows command-length limit

Passing the prompt as an argument runs into a platform ceiling. On Windows:

- `cmd.exe` caps a command line at **8,191** characters.
- The `CreateProcess` API caps at **32,767** characters.
- Anything the shell does with quoting and escaping eats further into that.

An implementation issue body plus its parent spec excerpt can exceed the lower bound easily. **Implementation must measure the real ceiling for the actual shell in use** (PowerShell and Git Bash differ) rather than assuming.

**The mechanism: spill to a file and `@`-reference it.** Claude Code expands `@path` in a prompt into the file's contents. So when a first prompt exceeds a configured threshold, the bridge:

1. Writes the bulk of the message to `.aboard/runtime/prompts/<agentId>.md`.
2. Launches with a short prompt that references it:

   ```
   claude --agent implementer --session-id <uuid> \
     "Implement issue #47. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first."
   ```

The file lives under the gitignored runtime directory and is retained for the session's lifetime so `--resume` can still resolve the reference.

```
aboard.launch.maxInlinePromptChars   // default 4000 — conservative, below every known ceiling
```

Below the threshold the prompt goes inline; above it, it spills. Spilling is **always safe**, so an implementation that is unsure should spill. The threshold exists only to avoid a pointless file write for short prompts.

#### 5.1.5 The launch command is a setting, not the literal `claude`

Every launch shape above is written as `claude …`, but the program is configurable. Claude Code is not always reached as a bare `claude` on `PATH`: there are compatible builds under other names, and users run profile wrappers that start it with fixed arguments of their own.

```
aboard.launch.claudeCommand   // default "claude"
```

**The setting is a token list, not just an executable.** A wrapper needs its own arguments before Claude Code's — `clauder run kiro --` selects a profile and hands everything after `--` to Claude Code. So the setting parses to a program plus leading arguments, and aboard appends its flags to those tokens; nothing about how its own arguments are passed changes.

- Written as a string it splits on whitespace, with `'...'` or `"..."` grouping a token that contains spaces, so a quoted program path (`"C:\tools\my claude.exe" run --`) still works. An array of strings is taken verbatim.
- Every token is quoted individually at build time, so the value is a program and its arguments, never a shell expression: `&&` or `|` would be passed as literal argument text rather than run.
- An empty, unquotable, or unparseable value warns and falls back to `claude` rather than reaching argv.

The tokens lead **every** command line — start and `--resume` alike — because a wrapper that is bypassed on resume would silently drop the profile it selected.

### 5.2 Session identity and resumability

The bridge **mints the session UUID before launch** and imposes it with `--session-id`.

This is load-bearing, not incidental. Because every session ID is known at creation time, **every worker is `--resume`-able by construction.** That is what makes possible:

- Re-engaging a brainstorm agent days later.
- Sending review feedback *back to the agent that wrote the code*, with its full context intact.
- Reconstructing history from `.aboard/runtime/` rather than by scraping transcripts.

Session IDs are recorded in `.aboard/runtime/fleet.json` alongside agent type, issue number, terminal ID, and status.

### 5.3 Automated workers

Perform a task and return a result. **Never typed into.** Their input is the launch prompt; their output is their final message.

**The prompt is mandatory.** An automated worker with no first message would sit at an empty TUI forever, and §5.1.3 forbids the only mechanism that could rescue it. `aboard__run_agent` therefore requires `prompt` in both delivery modes.

**The prompt must be self-sufficient (§5.8).** It carries the issue body inline, not a reference to fetch.

Consequence: they must launch with permissions already resolved (§8.3). A permission prompt in an unattended terminal is a deadlock — the worker waits at a TUI dialog forever, the lease never releases, and the chain stalls silently. aboard must never become a screen-scraper fighting TUI dialogs.

### 5.4 Interactive workers

Launched for the user, not for the Manager. The Manager receives no result. Success means *the user is now typing somewhere else.*

The bridge focuses the terminal on creation. The user works directly with the agent; the Manager is told only that the handoff happened.

**The prompt is optional here, and the two launch paths differ:**

| Path | Prompt |
| :-- | :-- |
| **Manager calls `aboard__run_agent` with `interactive: true`** | Usually supplies one — it has been talking to the user and knows the topic. Still optional. |
| **User runs the skill directly (§6.3)** | Usually **none**. The user is about to switch terminals and type the real message themselves. |

When no prompt is given, `claude` launches with no positional argument and opens at an empty prompt, ready for the user. This is the correct behaviour, not a degraded one — the user asked to go talk to an agent, not to have the Manager guess what they were going to say.

### 5.5 Sub-sub-agents

Workers **may** use Claude Code's built-in `Agent` tool internally. These sub-sub-agents:

- Stay entirely within their parent worker's process.
- **Do not** open VS Code terminals — that would produce an unmanageable terminal count.
- **Are** visible in the fleet tree.

"Invisible to the user" means *no terminal*, not *no UI representation*. Visibility is the project's thesis, so we take it wherever it is cheap. Per `hooks.md`, this costs nothing extra:

- `SubagentStart` (matcher: agent type) → tree node appears.
- `SubagentStop` → node resolves; `last_assistant_message` gives the result.
- `PostToolUse` on `Agent` → `tool_response` carries `agentId`, `content`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage`, `resolvedModel`. Free per-sub-agent cost telemetry.

### 5.6 Result reporting

A worker's `Stop` hook POSTs its result to the bridge. Per `hooks.md`, the hook reads **`last_assistant_message`** — not `transcript_path`, which is written asynchronously and may lag.

```
POST /hooks/stop
{ "agentId": "...", "sessionId": "...", "lastMessage": "...", "cwd": "..." }
```

The bridge then classifies the outcome (§8.1), releases the lease if held, updates the tree, and either fulfils a blocking `run_agent` call or files the result in a mailbox for the Manager's `Stop` hook to drain.

**Note on subagent frontmatter:** per `hooks.md`, `Stop` hooks declared in a subagent's frontmatter are automatically converted to `SubagentStop`. aboard's workers are top-level sessions, not subagents, so their `Stop` hooks fire as `Stop` — but any hook we place in an agent definition intended for *sub-sub-agent* use must account for this conversion.

### 5.7 The raw agent — working outside the workflow

**The user must always be able to just use Claude Code.**

Not every piece of work belongs in a spec issue. Sometimes the user wants to poke at something, try an idea, debug a weird failure, or ask a question — with plain, unconstrained Claude Code, with no agent definition, no issue binding, and no contract to satisfy.

aboard supports this as a **first-class launch type**, not as an escape hatch to be discouraged. A workflow that makes the ordinary tool harder to reach has made the user's life worse, which is the one thing §1.3 forbids.

**The raw agent is an interactive worker with no agent definition.** It launches with the inline shape (§5.1.1) and no `--agent`:

```
claude --session-id <uuid> ["optional first message"]
```

- No `--agent`, so no system prompt beyond Claude Code's own default.
- No `--tools` restriction unless the user configures one.
- No issue binding, no contract, no expected result.
- Focused on creation, like any interactive worker.

**Two launch paths, mirroring §6.3:**

- **The user runs the skill** (`/raw`, or whatever it ends up named) in the Manager's terminal. Hook-backed, zero tool calls, usually with no first message.
- **The Manager calls `aboard__run_agent` with type `raw`** (interactive, coerced if it forgets the flag). Useful when the Manager concludes the right move is "this needs a human poking at it directly" rather than a structured task.

**Why the Manager is told either way.** The raw agent is outside the workflow, but the *knowledge that the user went off to use one* is inside it. A Manager that knows the user has spent twenty minutes in a raw session on the auth module will not confidently brief them on a stale picture of the auth module — and it may sensibly ask whether that work should become an issue. **Being outside the workflow is not the same as being invisible to it.**

**Write-capability.** A raw agent has no `tools:` frontmatter to derive from, and its default tool set can write. It is therefore **classified write-capable and takes the write lease** (§8.1). This is the conservative reading and the right one: a raw session is exactly where the user is most likely to make ad-hoc edits, and the lease exists to stop that colliding with an implementer.

**Distinct from a session started by hand.** A `claude` the user launches in a plain VS Code terminal has no bridge token and is outside the system entirely (§3.2). The raw agent is bridge-created: tracked, resumable, lease-holding, and in the tree. The difference matters — one is a ghost, the other is a citizen with no job.

### 5.8 Prompt self-sufficiency: resolve before launch

**Rule: the bridge resolves everything a worker needs and puts it in the first prompt. Workers do not fetch what could have been handed to them.**

The naive design has the implementer start with "work on issue #47" and run `gh issue view 47` and `gh issue view 31` to get its own instructions. That costs two tool calls, two round-trips, and — most expensively — **the entire raw output of `gh` in the worker's context**, formatting and metadata included, before it has done a single useful thing.

The bridge already has to be involved to create the terminal. It can make those calls once, extract what matters, and hand over a prompt the worker can act on immediately:

> You are implementing issue #47 on branch `feat/47-token-refresh`.
>
> **Issue #47 — Add token refresh**
> \<full body\>
>
> **Parent spec #31 — Auth rework** (relevant sections)
> \<excerpt\>
>
> This issue is labelled `afk`. Implement it on the branch above and stop; aboard commits, opens the PR, and merges.

**What this buys:**

- Fewer GitHub calls, and their token cost paid once by a program rather than once per agent by a model.
- The worker's first action is work, not orientation.
- The `gh` output is parsed by the bridge, so the model never sees the noise.
- Fewer tools needed in each agent's allowlist.

**Where it stops.** A worker still needs `gh` for **re-grounding after compaction** (§8.4), where re-reading `gh issue view 47` is the recovery path precisely because the prompt may no longer be in context. Resolution-before-launch removes the *routine* fetch, not the *capability*. It no longer needs `gh` for writes: opening, updating, and merging PRs became the extension's job ([`auto-implementation.md`](./auto-implementation.md) §1).

**This applies to every agent type**, not just the implementer: a pr-doctor gets the diff, the issue, and the spec excerpt; the brainstormer gets the topic and any related issues.

---

## 6. Delegation Surface

### 6.1 Design intent

The delegation tool description should mirror the structure *and the wording* of Claude Code's internal `Agent` tool definition (available to the user at `prompt-engineering/claude-code-prompts/default-tools.json`, `tools[0]`), so the Manager brings the same priors to `aboard__run_agent` that it would to `Agent`. That includes its sections — the agent-type roster, "When not to use", usage notes, and "Writing the prompt" — and its parameter names, notably `run_in_background`.

**One launch tool with two flags, not three tools.** The earlier design used a tool per launch shape on the theory that what the Manager does *next* differs in each case. In practice the descriptions were near-identical, the Manager selected between them unreliably, and every shared instruction was paid for twice — a cost that grows as the descriptions earn the detail they need.

Both flags are kept because each carries information no other argument supplies:

- `interactive` decides whether a result exists **at all**. It is not derivable from `type`: the general-purpose worker types are launchable in either mode, and only the caller knows whether this one is the user's to drive.
- `run_in_background` decides **when** an automated result arrives, exactly as `Agent` models it.

### 6.2 The tools

#### `aboard__run_agent`

The single launch surface.

> **Narrowed by [`auto-implementation.md`](./auto-implementation.md) §2.** `implementer`, `pr-doctor-afk`, and `pr-doctor-hitl` are **not** launchable through this tool. They belong to the auto-run engine and to `review_pr`; the Manager reaches implementation work through `start_auto_run`, never by launching an implementer itself.

```jsonc
{
  "type": "string",           // agent type; "manager" is never launchable
  "prompt": "string",         // REQUIRED unless interactive; the first user turn
  "description": "string",    // 3-6 words, shown in the tree
  "issue": 123,               // optional; binds the worker and triggers
                              // prompt resolution (§5.8)
  "interactive": false,       // optional; default false
  "run_in_background": false  // optional; default false (foreground)
}
```

**Automated** (`interactive` absent or false). The worker works alone and reports back. Foreground blocks until it finishes and returns its final message as the `tool_result`; `run_in_background: true` returns immediately and the result is delivered at a later turn boundary by the Manager's `Stop` hook (§6.4). Returns `{ agentId, sessionId, status, result, telemetry }` or `{ agentId, sessionId, terminalId, status: "running" }` respectively. Foreground use requires `ABOARD_MCP_TIMEOUT` to be generous (§8.5).

**Interactive** (`interactive: true`). Focuses the terminal, hands it to the user, and returns handoff instructions. **No result is ever expected.** Returns `{ agentId, sessionId, terminalId, handoff: "..." }`.

`prompt` is **required for an automated launch** (§5.3) and **optional for an interactive one** (§5.4), where omitting it launches `claude` with no positional argument and leaves the user at a fresh prompt to type their own opening message. When `issue` is present the bridge resolves the issue and its parent spec and merges them into the launch prompt, so the Manager's `prompt` can be short and directive rather than a copy of the issue body.

**Two illegal combinations, handled differently, because only one of them is ambiguous:**

| Call | Bridge behaviour |
| :-- | :-- |
| An interactive-only type (`brainstormer`, `raw`) without `interactive: true` | **Coerced.** The launch has exactly one valid reading — those types exist only to be handed to the user, and their `Stop` hook is guarded off — so the bridge launches interactively and returns a `notice` telling the Manager no result is coming and to continue with the user. Rejecting would cost a round trip whose only possible retry is this same launch. |
| An automated launch with no `prompt` | **Rejected.** There is no valid reading to coerce to: the worker would sit at an empty TUI forever and §5.1.3 forbids the only mechanism that could rescue it. |

`run_in_background` alongside `interactive: true` is meaningless rather than ambiguous; it is ignored and noted in the result.

**Backgrounding and linearity are orthogonal.** `run_in_background` on a write-capable type does not violate single-writer; it means the Manager stays conversational while the single writer works. This is expected to be the dominant mode for `afk` work.

#### `aboard__start_auto_run`

Starts the automatic implementation workflow over the oldest open `spec` issue. Defined in full by
[`auto-implementation.md`](./auto-implementation.md) §3.

```jsonc
{}
```

**Non-blocking.** It returns the resolved plan — spec, ordered issues with dispositions, skips with
reasons — and the run proceeds independently of the Manager's turn, outliving it if necessary.
Progress arrives one bounded line at a time through the `UserPromptSubmit` notification drain, not as
a tool result. Also reachable as `/auto` and as a panel command.

#### TODO tools

The project TODO is a GitHub issue (§7.1), and these are how it is read and written. They exist so no agent is ever tempted to reach for session-task tools (§4.3) or to hand-roll `gh` calls against it.

**`aboard__get_todo`** — returns the current TODO body. Called on demand, not at session start; the briefing carries only a pointer (§4.5).

**`aboard__update_todo`** — replaces the TODO body.

```jsonc
{ "body": "string", "reason": "string" }  // reason is logged, not stored in the issue
```

The bridge resolves the TODO issue number itself (by the `todo` label, cached in `.aboard/runtime/`), so no caller ever needs to know or pass it. A missing TODO issue is created on first write.

#### `aboard__review_pr`

> **Reframed by [`auto-implementation.md`](./auto-implementation.md) §9.** It no longer launches a reviewer. It reopens the session that owns the latest open PR — focusing that terminal if it is live, resuming it if closed — and hands it to the user. It takes no arguments and returns no result.

On-demand review (§7.5). The **only** automatic-review path is the config setting, which ships off.

```jsonc
{}
```

#### `aboard__release_lease`

Escape hatch. Force-releases a stuck lease with a reason. Logged conspicuously; the extension also offers this as a command, because a lease that cannot be broken is worse than no lease.

### 6.3 User-initiated actions are hooks, not tool calls

Some actions need no judgement from the Manager. Launching an interactive brainstorm agent is one: the user knows what they want, and routing it through the Manager costs a reasoning turn, a tool call, and tokens to accomplish something mechanical.

Instead, a **`UserPromptSubmit` hook intercepts the command directly.** When the user types `/brainstorm <topic>` in the Manager's terminal, the hook recognises the pattern, POSTs to the bridge, and the bridge creates and focuses the terminal. `/done` uses the same path to close the invoking aboard terminal.

**This generalises into a rule:** any user-initiated action that requires no judgement should be a hook, not a tool call. It is the cheapest sufficient mechanism (§1.4.6).

#### 6.3.1 Deny the prompt with exit code 2 — do not inject context

**The hook exits 2. The prompt never reaches the model.** `hooks.md:703` is explicit: for `UserPromptSubmit`, exit code 2 **"Blocks prompt processing and erases the prompt."** Stderr becomes the message the user sees in place of a response.

```python
def finish(message: str):
    """
    Reject the prompt either way (success or failure) so it never reaches
    the model. `message` is what the user sees in place of a response.
    Exit code 2 is what makes Claude Code treat stderr as the rejection
    reason for a UserPromptSubmit hook.
    """
    sys.stderr.write("\n" + message.strip() + "\n")
    sys.exit(2)
```

**Why this beats `additionalContext`, which an earlier draft of this spec specified:**

- **`additionalContext` cannot suppress the prompt.** The raw `/brainstorm caching layer` text still reaches the Manager, so the injected context has to *talk the model out of acting on it* — "this was already done, do not call a tool." That is an instruction the model may or may not follow, spending a reasoning turn to arrive at doing nothing.
- **Exit 2 removes the turn entirely.** No prompt, no reasoning, no tool call, no tokens. There is nothing for the model to get wrong because the model is never invoked.
- **The user still sees confirmation** — stderr renders in their terminal. The feedback loop is intact; it simply does not pass through an LLM.

#### 6.3.2 Deferred notification: batch into the next real prompt

Exit 2 means the Manager learns nothing at the moment the command runs. That is correct — it should not be woken for a mechanical action — but it must not stay ignorant forever, because a Manager that does not know a brainstormer is running will brief the user wrongly.

**The mechanism: the hook stores what it did, and the next `UserPromptSubmit` that is *not* an intercepted command flushes the queue as `additionalContext` alongside the user's real message.**

```
User types /brainstorm caching layer
  → hook intercepts, launches agent, appends to queue, exit 2
     (model never runs)

User types /raw
  → hook intercepts, launches raw agent, appends to queue, exit 2
     (model never runs)

User types "what's the status of the auth work?"
  → hook finds a non-empty queue
  → exit 0, injecting additionalContext:
       "Since your last message: at 14:31 you started a brainstormer on
        'caching layer' (agent a1b2). At 14:36 you started a raw session
        (agent c3d4)."
  → the Manager answers the real question, fully informed
```

**Why this is the efficient shape:**

- **Zero turns are spent on notification.** The Manager is informed on a turn it was going to run anyway.
- **Batching amortises.** Five commands in a row cost one injection, not five.
- **It is naturally ordered.** The Manager learns what happened before it answers, so its answer accounts for it.

**Implementation requirements:**

- The queue is **bridge-side state**, keyed by agent ID — not a file the hook manages, so a crashed hook cannot lose or duplicate entries.
- Entries are **self-dating** (§4.5). Injected context is replayed verbatim on `--resume`, so every entry carries an explicit timestamp and is phrased as a past event. "At 14:31 you started a brainstormer" replays correctly as history; "a brainstormer is running" replays as a lie.
- The queue is **drained on read.** Delivered once, never repeated.
- A queue that grows unusually large is **summarised rather than truncated**, and never allowed to blow the injection budget (§4.5).

**Timeout constraint.** `hooks.md` documents a **30-second default timeout** for `UserPromptSubmit` `command` hooks — not the 600s that applies to most events — and it *blocks model processing* while it runs. Terminal creation is fast, but the `timeout` field must be set explicitly and the hook must fail non-catastrophically. **On timeout the prompt reaches Claude unmodified**, which for an intercepted command means the raw `/brainstorm ...` text lands in the Manager's context with no explanation. The Manager's system prompt must therefore state that a bare slash-command in its input means the hook failed, and that the correct response is to say so rather than to improvise.

**Precedent.** The user's existing `commit` skill already uses exactly this deny-the-prompt pattern. It is simpler — no deferred queue, because it has nothing to report — but the mechanism is proven in daily use.

### 6.4 Waiting for results

Two modes, matching Claude Code's own `run_in_background` axis:

| Mode | Manager behaviour | Delivery |
| :-- | :-- | :-- |
| `run_agent` (default) | Blocks inside the tool call | `tool_result` |
| `run_agent` with `run_in_background: true` | Continues immediately | Drained by `Stop` hook |

**The Manager's `Stop` hook** is the mechanism for background delivery *and* the safety net that prevents the Manager going idle on live work. It is a **Python command hook** that polls the bridge and sleeps (per the user's design):

```
On Stop:
  POST /hooks/manager-stop  { agentId, stopHookActive }
  → results pending?     deliver them, decision: "block", continue the turn
  → agents still running? sleep, poll again (long-poll within one turn)
  → nothing outstanding?  exit 0, allow the stop
```

Per `hooks.md`, `Stop` hooks accept `decision: "block"` with a `reason`, or `hookSpecificOutput.additionalContext` for non-error feedback that continues the conversation. **Results should be delivered as `additionalContext`, not as `block`+`reason`** — a result is not an error, and `block`+`reason` frames it to the model as "you were prevented from stopping" rather than "here is your result."

**On the 8-continuation cap.** `hooks.md` documents a cap of 8 consecutive `Stop`-hook continuations. This is not a constraint in practice: within a single wait the hook sleeps and polls *inside one turn* — Claude Code displays "executing stop hook" while it waits, and this is **one turn, not eight**. The cap only bites if there are genuinely 8 separate rounds of background results to deliver, which is a real situation where halting is the correct outcome. The hook must still read `stop_hook_active` and degrade gracefully.

---

## 7. Work Model: GitHub as the Backbone

### 7.1 The global TODO

**A GitHub issue labelled `todo`.** One per repository, pinned.

An earlier draft put this in a committed `.aboard/TODO.md`, on the reasoning that a file is diffable and git-historied. **That reasoning was wrong on the part that mattered.** A diff of a roadmap answers a question nobody asks — you care what the priorities *are*, not what they were four commits ago — while the costs of a file are real and daily:

| | Committed file | GitHub issue |
| :-- | :-- | :-- |
| Editing by an agent | Needs `Edit`/`Write` → makes the editor **write-capable** → takes the write lease | An MCP call. No lease, no file access |
| Editing by the user | Open the repo, edit, commit, push | Open the issue in a browser or the app, type |
| Editing from a phone | No | Yes |
| Visible without a clone | No | Yes |
| Survives a branch switch | It is *on* a branch | Not on any branch |
| Merge conflicts | Possible | Impossible |

The lease row is the decisive one. A Manager that edits `.aboard/TODO.md` needs `Write`, which under §8.1's derivation makes it write-capable, which makes the orchestrator compete for the write lease with the implementer it is orchestrating. Moving the TODO to GitHub removes that contradiction entirely — **updating the roadmap stops being a filesystem operation.**

It also puts the roadmap in the same place as every other durable fact in this system (§1.4.4), which is the point of having chosen GitHub at all.

**Access is via `aboard__get_todo` / `aboard__update_todo`** (§6.2), never raw `gh`. The bridge resolves the issue by label and caches its number in `.aboard/runtime/`, so no agent handles an identifier.

**Updating is not ticking boxes.** The list evolves as the project evolves: tasks appear, priorities change, obsolete tasks are deleted. It is intentionally **not** an exhaustive specification — that is what `spec` issues are for. Driven by the `update-todo` skill (§10.2).

**The one real loss** is that a GitHub issue has no diff. GitHub keeps an edit history on issue bodies, which covers auditing; there is no scenario in this workflow where a line-by-line roadmap diff drives a decision. Accepted knowingly.

`.aboard/runtime/` is gitignored and holds `bridge.json`, `manager.json`, `fleet.json`, prompt spill files (§5.1.4), and the event log.

### 7.2 Labels: minimal, derive the rest

GitHub already tracks open/closed, assignee, linked-PR status, review state, and thread resolution. **Every label that restates one of those is a sync bug waiting to happen**, because agents will update one and not the other.

A label exists only for facts GitHub cannot answer. There are exactly four:

| Label | Meaning |
| :-- | :-- |
| `spec` | This issue is an implementation contract. Also marks it as an **umbrella**. |
| `afk` | Shaped for autonomous work. **The agent may close it.** |
| `hitl` | Human in the loop. **Only a human may close it.** |
| `todo` | The project roadmap (§7.1). Exactly one issue carries it, and it is never closed. |

`todo` is structurally different from the other three: it is not a work item, it is a *singleton locator*. It exists so the bridge can find the roadmap issue without a hardcoded number.

**Derived facts — never labelled:**

- Leaf vs umbrella → `spec` present or absent.
- Ready to start → all dependencies closed.
- In progress → assignee or open linked PR.
- Needs changes → unresolved review threads.
- Done → closed.

**The absence of both `afk` and `hitl` is a legitimate third state:** an unclassified task. The Manager should **flag** these rather than guess, since guessing wrong means either an unattended agent closing work that needed review, or a chain stalling for approval nobody knew was required.

### 7.3 The gating rule

**One uniform rule: an issue may start when all of its dependencies are closed.**

`hitl` does not change the gate. It changes **who may close**:

| Label | Terminating action | Effect |
| :-- | :-- | :-- |
| `afk` | PR opened with `Closes #N`, then merged | Issue closes, dependents unblock, no human in the path |
| `hitl` | PR opened, then **stop** | **The user's merge is the approval** |

This collapses two concepts into one primitive. There is no separate approval state to model, no "waiting-for-review" label, and no synchronisation to get wrong. The Manager's readiness query is one `gh` call against closed-ness, identical for both kinds.

> **Amended by [`auto-implementation.md`](./auto-implementation.md) §1 and §6.3.** The terminating action is performed by the **extension**, not by the implementation agent — the agent no longer reads its own labels to decide whether to run `gh pr merge`. "The user's merge is the approval" turns out to be load-bearing for a second reason discovered later: GitHub refuses `gh pr review --approve` on a PR opened by the same account, so on a solo repository no automated approval is possible at all. The rule was right; the reason is stronger than originally stated.

**`hitl` is also the brake on autonomous chains.** A chain of `afk` issues runs unattended to completion; one `hitl` in the middle is a hard stop that survives the user closing their laptop, because the state lives in GitHub and not in any agent's context. "How far can this run without me" therefore becomes a property set at issue-creation time — exactly where `publish-issues` already operates.

### 7.4 The workflow

1. **Start/resume the Manager.** It briefs the user on project state and recommends a next priority — revisit an incorrectly implemented feature, address review comments, start a new feature, update the roadmap.
2. **User picks a direction.**
3. **Brainstorm.** The Manager launches an interactive brainstorm agent (or the user invokes `/brainstorm` directly, §6.3) and hands off. That agent's sole responsibility is producing a complete specification as a large GitHub issue. It may launch built-in `Explore` sub-sub-agents, explore the codebase itself, and use the `grill-me` and `lavish` skills. **A brainstorming session always ends with an issue labelled `spec`** — the implementation contract.
4. **Split — three skills, in order.** The spec becomes implementation issues through a pipeline the user already owns and uses:

   | Skill | Does |
   | :-- | :-- |
   | `/map-issues` | Reads the spec and produces the decomposition — what the issues are, how they depend on each other |
   | `/draft-issues` | Turns the map into full issue bodies, for the user to review before anything is public |
   | `/publish-issues` | Creates the issues on GitHub with labels and dependency links |

   Splitting this into three steps is the point: **the user reviews the decomposition before it exists on GitHub.** A bad split discovered after publication is a cleanup job; discovered at the draft stage it is an edit. Each issue is sized for exactly one agent and labelled `afk` or `hitl`.

5. **Implement.** The user starts an auto-run (`/auto`), or the Manager does via `start_auto_run`. The extension walks the spec's issues one at a time, creating each branch, launching an implementation agent, and committing and opening the PR itself. **The bridge resolves the issue and its parent spec into the launch prompt** (§5.8), so each agent starts with its full contract already in hand rather than fetching it. See [`auto-implementation.md`](./auto-implementation.md).
6. **Land.** `afk` is merged by the extension; `hitl` waits for the user's merge.
7. **Repeat.** Via hooks and the bridge, the Manager always knows exactly what has completed and can recommend the next action.

**None of this is mandatory.** At any point the user can open a raw Claude Code session (§5.7) and just work. The workflow is a path, not a wall.

### 7.5 Review and feedback

**Implementation lands as branch + PR per implementation issue.** Chosen because review comments become durable, `gh`-readable artifacts that a fix agent retrieves by exactly the same mechanism it retrieves the spec — and because the Manager's "what needs attention" becomes one `gh` call rather than a reconstruction from session history. Branches are sequential (single-writer), so there are no worktrees and no merge conflicts.

> **Superseded by [`auto-implementation.md`](./auto-implementation.md) §7 and §9.** The invariant below — review never runs automatically unless the user opts in — is unchanged and still binding. What changed is its shape: the tri-state `aboard.review.autoReview` is replaced by the boolean `aboard.autoRun.review`, the read-only reviewer and the separate fixer are replaced by the two **pr-doctor** agents that review *and* fix in one context, and `review_pr` is reframed as "reopen the session for the latest open PR" rather than "launch a reviewer". The paragraphs below describe the original design and are kept for the reasoning, not the mechanism.

**Review never runs automatically.**

```
aboard.review.autoReview: "never" | "hitl" | "all"     // ships as "never"
```

This is a **default, not a recommendation** — nothing in the system may re-derive it. The whole workflow already costs significant LLM API spend, and review is the user's call. The `"hitl"` and `"all"` values exist for a user who deliberately opts in.

**On-demand review** is the only path that runs by default: `aboard__review_pr`, or a button on the PR in the extension UI. A read-only reviewer agent reviews the diff against the spec issue and posts findings as **PR review comments** on specific lines. The user triages — dismisses noise, adds their own. The Manager then launches a fix agent against the surviving threads.

**Why findings go to GitHub rather than back to the Manager:** they survive session loss, they are retrievable by a fix agent via `gh`, and the user can reply or dismiss inline. A structured report into the Manager's context evaporates when that context does.

**Why the reviewer/fixer split was dropped:** a fix agent retrieving threads via `gh` must re-read every file the reviewer already read, in order to act on reasoning it did not form. The durability argument above is real but it does not require two agents — it requires the findings to be durable, which they are once the work lands as a commit on the PR. One agent that reviews and fixes in the same context pays for the analysis once.

**Unreviewed merges are surfaced, not prevented.** The briefing reports "N PRs merged unreviewed since your last session" at zero token cost, so retro-review remains the user's choice rather than an omission.

---

## 8. Invariants and Failure Handling

### 8.1 Single writer: the write lease

**No parallelism. No worktrees.** Quality over speed. Concurrent agents in one repository trade a real correctness problem — merge conflicts, and agents contradicting each other — for a speed gain that was never requested.

This is enforced **structurally**, not by prompting. The bridge is the only path by which any agent is created (§1.4.5), so it holds a **single write lease on the workspace**:

- `run_agent` for a **write-capable** type **fails immediately** if the lease is held, returning who holds it and since when.
- The Manager surfaces that to the user rather than queuing. With "quality over speed", a task that waits 20 minutes for a lease is a task whose premise may have gone stale by the time it runs.
- **Read-only types are exempt** and stay concurrent. Three reviewers at once cost nothing and touch nothing.

**Capability class is derived, not declared.** The bridge reads the agent's `.claude/agents/<type>.md` frontmatter: a `tools:` list with no `Edit`, `Write`, or `NotebookEdit`, and no unrestricted `Bash`/`PowerShell`, **cannot** write, so the bridge classifies it read-only. There is no flag to forget and no flag to lie about. This derivation is sound because every aboard agent declares its tool set in its definition and no launch combines `--agent` with `--tools` (§5.1.1) — no launch flag can widen an agent past what its file declares. The Manager declares the read-only list like any other agent and never holds the lease.

**An agent with no definition is write-capable.** The raw agent (§5.7) has no frontmatter to read and Claude Code's default tool set can write, so it takes the lease. Unknown capability resolves to the restrictive answer, always.

**Clean handoff.** Linearity only holds if each worker leaves the tree in a defined state. "Ends with a commit" is the implementation agent's contract, and the bridge verifies `git status --porcelain` is empty before releasing the lease. A dirty tree is a typed failure (§8.2) reported to the Manager — never a silent handoff of someone else's half-finished work to the next agent.

**The user is also a writer.** The user editing `src/foo.ts` while an implementation agent edits it is the same conflict, minus the merge. Therefore:

- The **status bar** shows the current lease holder.
- **Saving a file while an agent holds the lease warns** the user.

Not a hard block: hard-blocking edits is actively hostile the moment the user needs to intervene in a stuck run.

### 8.2 Typed failures

A worker that dies, hangs, or exits dirty must produce a **typed** result, so the Manager can act rather than improvise:

| Type | Meaning | Manager's reasonable action |
| :-- | :-- | :-- |
| `crashed` | Non-zero exit, no result | Retry once, then escalate |
| `context-exhausted` | Filled context and could not recover | Escalate — the issue is too large (§8.4) |
| `permission-denied` | Blocked on a permission it lacked | Escalate — configuration problem |
| `no-commit` | Finished with a dirty tree | Escalate — needs human inspection |
| `timeout` | Exceeded its wall-clock budget | Escalate with partial state |
| `killed` | Terminal closed by the user | Treat as deliberate cancellation |

Each carries the terminal exit code and the last assistant message. **The lease always releases**, on every path. `onDidCloseTerminal` provides lifecycle and exit-code capture.

The bridge also runs a `StopFailure` hook per agent, and treats an unexpected `onDidCloseTerminal` as `crashed` or `killed` depending on exit code.

### 8.3 Permissions

**Entirely the user's decision.**

The extension **warns once**: without bypass mode, `afk` agents cannot work unattended, because a permission prompt in an unwatched terminal is a silent deadlock (§5.3). It **recommends `--dangerously-skip-permissions`** for worker launches.

The mitigations are real and worth stating: PR-per-issue means every change is reviewable before it lands; git history means every change is recoverable; single-writer means only one agent is ever acting.

The setting:

```
aboard.workers.permissionMode: "bypass" | "acceptEdits" | "default"
```

The setting is named for the case that motivates it, but it describes how aboard launches Claude Code rather than one agent type: it is applied to **every** session aboard starts or resumes, the Manager included. A Manager that stops on a prompt the user chose to bypass everywhere else is the same silent deadlock, in the one terminal the rest of the fleet depends on. It is read at launch time, so a change takes effect on the next start or resume, not on a running session.

No bridge-mediated permission policy engine is built. (A `PreToolUse` http hook routing decisions to the bridge — with a rules table, escalation to a VS Code notification when a human is present, and deny-with-reason for `afk` agents so they adapt rather than hang — remains a coherent future option. It slots in behind the same setting. It is explicitly out of scope for v1 on cost/complexity grounds.)

### 8.4 Context exhaustion

**Auto-compact removes the hard failure.** A worker that fills its window compacts and continues rather than dying. It is on by default in Claude Code. The scaffolder **detects whether the user has disabled it and warns** — it does not write the setting (§10.3), because silently overriding a user preference in a shared file is exactly the UX failure §4.3.1 rules out.

**Compaction is lossy, and the residual risk is specific:** an implementation agent that compacts mid-task can lose its launch prompt — which, per §5.8, is where its entire contract was handed to it. This is survivable for a structural reason: **the contract also lives in GitHub.** A compacted worker re-reads `gh issue view N` and recovers everything. This is the second dividend of the GitHub-as-backbone choice, and it is why §5.8 removes the *routine* fetch without removing the *capability*.

**Compaction becomes a re-grounding event.** Per `hooks.md`, two hooks fire on compaction: `SessionStart` with `source: "compact"`, and `InstructionsLoaded` with `load_reason: "compact"`. **Only the first can re-inject context.** `InstructionsLoaded` is documented as having no decision control — it cannot block or modify instruction loading, and its exit code is ignored — so `additionalContext` returned from it is silently discarded. The re-grounding hook therefore registers on `SessionStart` with `matcher: "compact"` alone. `InstructionsLoaded` remains available for observability, but must never be relied on to deliver context.

The scaffolder installs a re-orientation hook so that after any compaction the worker is re-injected with:

> You are aboard worker `$ABOARD_AGENT_ID`, implementing issue #N on branch X. Re-read the issue and spec before continuing.

A compacted worker therefore comes back **oriented**, rather than guessing from a summary. Cheap, precise, and aimed exactly at the failure mode.

**Two free wins:**

- `PostCompact` carries `compact_summary` → the bridge logs it, and the tree shows "compacted ×2" per agent.
- **Repeated compaction is a scoping signal.** A worker that compacts twice was given too much work. That is measurable feedback into how `publish-issues` sizes issues — otherwise noticeable only anecdotally.

### 8.5 Timeouts

Hook timeouts are configurable per-hook via the `timeout` field, and the defaults differ by event. Set them explicitly rather than discovering them mid-run:

| Hook | Default | aboard value | Reason |
| :-- | :-- | :-- | :-- |
| Manager `Stop` | 600s | **3600s** | Long-polls for background results |
| `UserPromptSubmit` | **30s** | 60s | Blocks model processing; must stay fast |
| Worker `Stop` | 600s | default | Just POSTs a result |
| `SessionStart` | 600s | 120s | Briefing assembly with `gh` calls |
| `PostCompact` | 600s | default | Logging only |

A foreground `aboard__run_agent` blocks for as long as a worker runs, so the MCP client timeout must match the Manager `Stop` value.

### 8.6 Settings hot-reload

Per `settings.md`, Claude Code watches settings files and reloads them on change — including `permissions` and `hooks` — and fires a `ConfigChange` hook per detected change. Two consequences:

1. Changing `aboard.manager.disallowedTools` or other aboard settings needs no extension rebuild (a Manager restart is still required, because its tool set and deny list are resolved at launch).
2. The bridge can subscribe to `ConfigChange` and react to configuration edits live.

---

## 9. Agent Catalogue

Agent definitions live in `.claude/agents/*.md` and are scaffolded and owned by the extension (§10.3). Each declares a system prompt, a `tools:` allowlist, a model, and optional frontmatter hooks.

**The `tools:` list is load-bearing twice:** it constrains the agent, and it is what the bridge reads to derive write-capability for the lease (§8.1). It must never be edited casually. Per §5.1.1, an agent launched with `--agent` takes its tools from this file and nothing at launch can widen them — which is what makes the derivation sound.

**Reuse Claude Code's built-in agents wherever they already do the job.** aboard defines an agent type only where the built-in roster has no equivalent. Every custom definition is a file to maintain, a prompt to keep current, and a divergence from what Claude Code does on its own.

**This section specifies the roster and contracts. The system prompts themselves are the highest-value remaining work** — quality lives in the prompts, and they deserve dedicated iteration rather than being drafted here.

### 9.1 `manager`

Launched as the main session agent: `claude --agent manager` (§5.1.1). Its contract is enforced structurally by the `tools:` allowlist and by prompt through `.claude/agents/manager.md`.

**aboard scaffolds no `CLAUDE.md`.** That file is the user's, it applies to every Claude Code session in the workspace — workers and hand-started sessions included — and a Manager persona written there would leak into all of them.

- **Model:** opus
- **Tools:** the read-only list in the definition's `tools:` field (§4.3).
- **Must:** orchestrate, brief, recommend, delegate, track state.
- **Must never:** write code; reason deeply about an individual feature; read large files.
- **Backstop:** because "never reason deeply" is prompt-enforced rather than structural, the prompt must state it forcefully, and the Manager should be given an explicit turn/token budget per delegation decision.

### 9.2 `brainstormer` (interactive)

- **Model:** opus
- **Write-capable:** no (produces a GitHub issue via `gh`, not code)
- **Tools:** `Read`, `Grep`, `Glob`, `Bash(gh *)`, `Agent`, `Skill`, `AskUserQuestion`
- **Contract:** ends with a GitHub issue labelled `spec`.
- **Skills:** `grill-me`, `lavish`.
- **May:** launch built-in `Explore` sub-sub-agents (§9.4); explore the codebase directly.
- **Style:** one question at a time, each with a recommended answer (per `grill-me`).
- **Launch prompt:** the topic, plus any related issues the bridge resolved (§5.8). May launch with no prompt at all when the user invokes `/brainstorm` bare (§5.4).

### 9.3 `implementer` (automated, write-capable)

- **Model:** opus
- **Write-capable:** yes → **takes the write lease**
- **Tools:** `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `LSP`, `Agent`, `Skill`
- **Launch prompt:** the issue body, the relevant parent-spec excerpt, the branch name, and the `afk`/`hitl` disposition — **all resolved by the bridge before launch** (§5.8). The implementer does not fetch its own instructions.
- **Contract** — *amended by [`auto-implementation.md`](./auto-implementation.md) §1 and §6; steps 1 and 3–5 below are now the extension's job:*
  1. ~~Create/switch to the issue's branch.~~ The extension creates and checks out the branch before launch.
  2. **Implement.** This is the whole contract. It ends at "the working tree contains the change".
  3. ~~Commit.~~ **The implementer must not run `git commit`, `git push`, or `gh`.** A dirty tree is its expected success state, and an empty diff is its failure mode.
  4. ~~Open a PR referencing the issue.~~ The extension opens it, using the agent's final message as the PR body.
  5. ~~If `afk`, merge.~~ The extension merges; see §7.3 and `auto-implementation.md` §6.3.
- **`gh` remains available** only as the compaction recovery path (re-reading its own issue), not for writes.
- **Re-grounding:** must re-read its issue via `gh issue view` after any compaction (§8.4) — the one case where fetching is correct, because the launch prompt may no longer be in context.

### 9.4 Codebase exploration — use the built-in `Explore` agent

**aboard defines no `explorer` agent.** Claude Code ships one.

The built-in `Explore` agent is a read-only search agent that reads excerpts rather than whole files and returns findings rather than dumps — which is exactly the contract an aboard-defined explorer would have declared. Writing our own would produce a worse copy that we then have to maintain against upstream improvements.

Workers that need codebase exploration use `Agent` with the built-in `Explore` type as a sub-sub-agent (§5.5). It costs no terminal, it appears in the fleet tree via `SubagentStart`/`SubagentStop`, and its telemetry arrives free through `PostToolUse`.

The Manager does **not** have `Agent` (§4.3), so it cannot explore this way — by design. If the Manager needs something read from the codebase, that is a signal it is about to reason deeply about a feature (§4.2), and the answer is to delegate the whole task.

### 9.5 / 9.6 `reviewer` and `fixer` — **removed**

Both are superseded by the two **pr-doctor** agents defined in
[`auto-implementation.md`](./auto-implementation.md) §7. A review agent that hands its conclusions to
a separate fix agent forces that agent to re-read every file the reviewer already read, to act on
reasoning it did not form. The pr-doctors review *and* fix in one context:

- **`pr-doctor-afk`** (automated, write-capable) — reviews the diff and applies its fixes directly.
- **`pr-doctor-hitl`** (interactive, write-capable) — reviews the diff, presents its findings to the
  user, and applies only what the user agrees to. Same capability, different permission to act.

Review is still opt-in and still never automatic by default (§7.5).

### 9.7 `raw` (interactive, unconstrained)

Not an agent definition at all — the **absence** of one (§5.7).

- **Launched without `--agent`:** no system prompt beyond Claude Code's default, no tool restriction.
- **Write-capable:** yes → **takes the write lease.** Conservative by necessity: a raw session is where ad-hoc edits are most likely, and the lease exists to stop those colliding with an implementer.
- **Prompt:** optional, usually absent.
- **Contract:** none. There is no result, no issue, and no expectation. The Manager is told it started and nothing more.

Listed in this catalogue not because it needs a definition, but so that nobody later writes one.

---

## 10. Skills and Assets

### 10.0 What this project must NOT build

**Read this before writing any skill.**

Most of the skills in this workflow **already exist and are owned by the user.** They are finished, in daily use, and outside this repository's scope. No agent working on aboard may implement, rewrite, or "improve" them:

| Skill | Status |
| :-- | :-- |
| `map-issues` | **Exists. Do not implement.** |
| `draft-issues` | **Exists. Do not implement.** |
| `publish-issues` | **Exists. Do not implement.** |
| `grill-me` | **Exists. Do not implement.** |
| `lavish` | **Exists. Do not implement.** |
| `commit` | **Exists. Do not implement.** |

aboard **integrates** these — invokes them, registers them, ships them alongside its own assets — but their content is not this project's work. An agent that finds one of them missing from a scaffold should report that, not author a replacement.

**aboard owns exactly six skills**, each a thin trigger for extension behavior:

| Skill | Why aboard owns it |
| :-- | :-- |
| `update-todo` | Operates on the TODO issue via `aboard__update_todo`. Meaningless outside aboard. |
| `brainstorm` | Hook-backed launch of an aboard interactive worker. Meaningless outside aboard. |
| `raw` | Hook-backed launch of an unconstrained aboard interactive worker. Meaningless outside aboard. |
| `done` | Hook-backed closure of the invoking aboard terminal. Meaningless outside aboard. |
| `auto` | Starts the auto-implementation run ([`auto-implementation.md`](./auto-implementation.md) §3). |
| `review-pr` | Reopens the session owning the latest open PR (§9 of the same document). |

Everything else on the list is a general-purpose tool that happens to be used here.

**Also removed:** the earlier draft assumed an aboard-specific *fork* of `publish-issues` that would know about `afk`/`hitl`. That was wrong twice — the user's existing three-skill pipeline already does this job, and forking it would create exactly the maintenance divergence §10.1 argues against. If the pipeline needs to know aboard's labels, that is a change to the user's skills, made by the user, not a fork living here.

### 10.1 Installed by command, not vendored or submoduled

The user's skills live in a separate `harness` repository. aboard **ships no copy of them at all** — not as build assets, and not as git submodules. Each is installed into a scaffolded project by **running its upstream install command**, declared in a single table (`VENDORED_SKILLS` in `src/scaffold/project.ts`) with one command per skill.

Reasons, specific to shipping an extension:

1. **Submodules pin a commit.** Improving a skill would require a bump commit in aboard — friction on precisely the files that will iterate most.
2. **Copies-in-tree drift silently.** A vendored copy is only as fresh as the last re-vendor; `harness` moves and aboard ships a stale skill that looks authoritative. The failure is invisible until a user notices behavior that upstream fixed months ago.
3. **A copy quietly changes ownership.** Once a user file sits in `assets/`, it reads as an extension asset, and §10.0's ownership line erodes one convenient edit at a time.

`harness` remains exactly as it is, and remains the only place these skills are edited. **Improvements are made upstream and picked up by re-running the install command** — there is nothing here to re-vendor.

The scaffolder therefore **never writes under `.claude/skills/<user-owned-skill>/`** and never claims those files in its manifest; the install command owns that directory. A skill with no command configured, an install command that fails, and a copy left behind by an older shipped-copies build are all **reported to the user** (§10.0: report, do not author a replacement) — the last is left on disk untouched rather than retired.

### 10.2 The skill set

| Skill | Owner | Invocation | Purpose |
| :-- | :-- | :-- | :-- |
| `map-issues` | **user** | user, on a spec | Decompose a spec into an issue map |
| `draft-issues` | **user** | user | Draft full issue bodies for review before publishing |
| `publish-issues` | **user** | user | Create the issues on GitHub with labels and dependencies |
| `grill-me` | **user** | user, in brainstormer | One-question-at-a-time interviewing, each with a recommended answer |
| `lavish` | **user** | user, in brainstormer | (User-owned) |
| `commit` | **user** | user | Commit-message quality; already uses the exit-2 pattern of §6.3.1 |
| `update-todo` | **aboard** | user, in Manager | Evolve the TODO issue via `aboard__update_todo` |
| `brainstorm` | **aboard** | user, in Manager | Hook-backed interactive-agent launch (§6.3) |
| `raw` | **aboard** | user, in Manager | Hook-backed unconstrained interactive-agent launch (§5.7) |
| `done` | **aboard** | user, in any aboard terminal | Hook-backed terminal closure (§6.3) |

Skills use `disable-model-invocation: true` where they are meant to be user-triggered only, and `argument-hint` for discoverability (both confirmed in `skills.md`).

A `raw` launch skill (§5.7) is the obvious sibling of `brainstorm` and shares its hook implementation; naming is open (§14).

**One deliberate omission — the history-sync script is dropped.** It exists in `harness` because `harness` has no extension and must scrape `~/.claude/projects/` to reconstruct what happened. aboard **launched every session and minted every session ID**, so `.aboard/runtime/` is a strictly better source — it knows agent type, issue number, terminal, exit status, and lease history, none of which a JSONL scrape can recover. Keep a scrape only if the user later wants visibility into sessions started outside aboard, which per the token invariant (§3.2) are outside the system by design.

### 10.3 Scaffolding

An extension command scaffolds project assets:

```
.claude/
  agents/          brainstormer.md, implementer.md,
                   pr-doctor-afk.md, pr-doctor-hitl.md
                   (no explorer — built-in Explore is used, §9.4)
  hooks/           Python hook scripts
  skills/          update-todo, brainstorm, raw, done,
                   auto, review-pr                  (aboard-owned)
                   map-issues, draft-issues, publish-issues,
                   grill-me, lavish, commit         (user-owned: installed by
                                                     command, never shipped, §10.1)
  settings.json    HOOK REGISTRATION ONLY
.mcp.json          bridge MCP registration (no secrets)
.aboard/
  runtime/         gitignored: bridge.json, manager.json, fleet.json,
                   prompts/, events
.gitignore         += .aboard/runtime/
```

**`settings.json` gets hooks and nothing else.** Per §4.3.1, aboard must not write `permissions` — that block belongs to the user and applies to every session in the workspace, not just aboard's. Per-agent restriction is `--disallowedTools` at launch.

**No `autoCompact` write either.** It is on by default in Claude Code; writing it into project settings would be aboard overriding a user preference in a shared file for the sake of a default that is already correct. If the user has disabled it globally they had a reason. The scaffolder **detects and warns** instead (§8.4).

**There is no `TODO.md`** — the roadmap is a GitHub issue (§7.1). The scaffolder creates that issue with the `todo` label if it does not exist.

The extension **owns the files it wrote**, versions them, can upgrade them, and **warns rather than clobbers** when it detects local edits. Everything is plain text and diffable, so a user can always see what changed. **User-owned skills (§10.0) are outside that ownership entirely** — the scaffolder re-runs their install command and never reads, merges, or removes their files.

---

## 11. Technology Stack

| Concern | Choice | Rationale |
| :-- | :-- | :-- |
| Extension | **TypeScript**, esbuild bundle | Types across the bridge protocol catch drift between extension and hooks — the protocol will have a dozen message shapes |
| Repo layout | **Single repo**, no monorepo tooling | Right size for the project; workspaces add setup without benefit yet |
| Bridge + MCP | **In-process** in the extension host, streamable HTTP | Direct VS Code API access, shared lifecycle, no IPC |
| Hooks | **Python** command hooks | Hand-debuggable and hand-editable; the user's machines have `uv`. The `type: "http"` alternative would remove the interpreter dependency but costs inspectability. **Every script opens with the §3.4 self-guard** — hooks are project-scoped, not agent-scoped |
| Terminals | `window.createTerminal()` | Real PTY/conpty. `vscode.Pseudoterminal` cannot render a real TUI |
| UI | **Native TreeView + status bar** | Cheap, fast, native theming, click-to-focus. Webview deferred until telemetry outgrows it |
| Work state | **GitHub via `gh` CLI** | Durable, survives compaction and session loss, already the user's workflow |
| Distribution | VS Code extension (`vsce`) | Marketplace or VSIX |

### 11.1 UI detail

**TreeView** — the fleet, hierarchically:

```
Manager  (session abc123, compacted ×1)
├─ implementer #47  running · lease holder · 14:32
│  ├─ Explore  auth module        done · 12.4k tok
│  └─ Explore  test conventions   running
├─ brainstormer  "caching layer"  interactive · awaiting user
└─ raw  (no goal)                 interactive · 08:12
```

Click → focus terminal. Context menu → send message, kill, resume, release lease.

**Status bar** — bridge port, lease holder, live agent count.

**Notifications** — worker completion, typed failures, lease conflicts, the one-time permission warning.

---

## 12. Prototype Provenance

Two prototypes established feasibility:

**`prototypes/board-terminal-bridge1`** — proves the three things aboard needs: start a terminal and boot a TUI in it; identify the terminal (stable UUID, look up later); register closure (global `onDidCloseTerminal` flips status and records exit code). Loopback-only, status bar indicator. Its API — `POST /terminals`, `GET /terminals`, `GET /terminals/:id`, `POST /terminals/:id/send`, `/keys`, `/show`, `DELETE /terminals/:id`, `GET /events` — becomes the bridge's terminal-control layer.

Documented caveats carried forward: `pid` races a 250ms timeout (treat `undefined` as informational); **the prototype has no auth**, which §3.2 fixes with the token. SSE is explicitly **not** required — the `Stop`-hook long-poll covers the notification need.

`/send` and `/keys` remain in the bridge but are for **interactive agents and user takeover only**. Automated workers are never typed into (§5.3).

**`projects/clh-poc/y.py`** — obsolete. It worked around not knowing a session ID in advance by scraping a temp `CLAUDE_CONFIG_DIR` for a marker string and rewriting JSONL. **`--session-id` supersedes it entirely.** Recorded here only so nobody rebuilds it.

---

## 13. Reference Documentation

`docs/CLAUDE-REFERENCES/` holds the authoritative Claude Code docs this design is built on. **Implementation must verify against these rather than against recollection.**

Present: `README.md`, `settings.md`, `skills.md`, `hooks.md`, `tools-reference.md`.

**Requested additions** — needed to verify flag-level details currently inferred:

- `cli-reference.md` — exact `--tools`, `--session-id`, `--agent`, `--resume`, `--permission-mode` semantics
- `sub-agents.md` — full agent frontmatter reference
- `mcp.md` — HTTP MCP server registration and `.mcp.json` schema
- `headless.md` — `-p` behaviour, exit codes
- `permissions.md` — rule format, read-only command set, working directories

---

## 14. Open Questions

Deliberately unresolved; each needs the user's input or dedicated iteration.

1. **System prompts for every agent type (§9).** The highest-value remaining work. Quality lives here.
2. **`update-todo` skill** — exact evolution semantics. One of only two skills aboard owns (§10.0).
3. **Name for the raw-launch skill** (§5.7) — `/raw`, `/claude`, `/plain`, something else.
4. **~~`manager.toolPreset` default~~** — retired: the Manager's tool list now lives in `manager.md` like every other agent (§4.3); the user tunes it by editing the file.
5. **The real Windows command-length ceiling** (§5.1.4) — measure per shell (PowerShell vs Git Bash). `aboard.launch.maxInlinePromptChars` defaults to a conservative 4,000 until it is known.
7. **How `map-issues`/`draft-issues`/`publish-issues` express dependencies** — issue-body task lists, GitHub's native blocked-by, or a convention. Determines how the readiness query (§7.3) is written. **This is a question about the user's existing skills, not a design decision for this project** (§10.0).
8. **Multi-root workspaces** — out of scope for v1; assume one workspace root per bridge.
9. **Non-GitHub backends** — out of scope. The design is deliberately GitHub-coupled.
10. **Messaging a finished agent (`send_to_agent`)** — out of scope for v1. Resuming a finished worker as `claude --resume <session-id> "<message>"` (re-engaging a brainstormer, routing review findings to the original implementer) stays a coherent future option on the same CLI-argument path as a first prompt, but v1 always launches a fresh agent.
11. **Fleet awareness is pushed, not pulled** — there is no `list_agents` tool; knowing which agents run is imposed on the Manager rather than left as its decision. Stop-hook result delivery already pushes completions; an automatic hook reminder of the still-running agents is planned and out of scope for v1.

---

## 15. Summary of Load-Bearing Decisions

For quick reference, and to prevent silent re-litigation:

| # | Decision | Consequence if reversed |
| :-- | :-- | :-- |
| 1 | `tools:` allowlist omits `Agent`; MCP replaces it | Manager reaches for in-process sub-agents; all visibility lost |
| 2 | Bridge mints `--session-id` | No Manager resume; no durable fleet history |
| 3 | Bridge is the only creator of agents | Fleet state becomes unreliable; lease unenforceable |
| 4 | Env injection carries port + token + identity | Multi-window breaks; hooks need heuristic correlation |
| 5 | Write lease, capability derived from `tools:` | Concurrent writers; merge conflicts; contradicting agents |
| 6 | GitHub holds all durable work state | Compaction and session loss become data loss |
| 7 | Four labels only; everything else derived | Label/state sync bugs |
| 8 | `hitl` = only a human may close | Approval becomes a separate state to model and desync |
| 9 | Review off by default | Unwanted API spend; the user loses control of cost |
| 10 | One long-lived Manager, compacted not restarted | Conversational continuity lost — the Manager's core value |
| 11 | Real PTY terminals | TUIs render garbled |
| 12 | Goal is experience, not automation | The project becomes a different, worse product |
| 13 | aboard never writes user `permissions` settings | Clobbers user config; scopes every session, not one agent |
| 14 | First prompt is a CLI argument; never typed into a live TUI | Update notices and callouts silently swallow prompts |
| 15 | `--agent` never combines with `--tools`; every agent's tool set is its definition's `tools:` field, the Manager's included | Launch silently ignores half its configuration; lease derivation becomes a guess |
| 16 | Bridge resolves prompts before launch (§5.8) | Every worker pays `gh` output in context to learn its own job |
| 17 | Intercepted commands exit 2, never inject context | Model wakes for mechanical actions and may act on them twice |
| 18 | TODO is a GitHub issue, not a file | Editing the roadmap requires write tools → the Manager competes for its own lease |
| 19 | No session-task tools in the Manager's tool list | Agents conflate session scratch state with the project roadmap |
| 20 | Raw agent is first-class (§5.7) | Users are pushed out of the tool they came for; workflow becomes a wall |
| 21 | Most skills are user-owned; aboard owns two | Reimplementation, divergence, and maintenance of tools that already work |
| 22 | Every hook self-guards on `ABOARD_AGENT_ID` (§3.4) | Hooks fire in every session in the workspace — Manager logic runs inside workers, and the user's own sessions get hijacked |
