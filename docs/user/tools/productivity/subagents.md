# Subagents

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install subagents`; see [installation and scope](../../getting-started.md).

## Use it

The `subagents` package delegates bounded work to persistent Claude Code, Codex, or Pi conversations. Invoke `/subagents-toolkit` in Claude Code, `$subagents-toolkit` in ChatGPT, or `/skill:subagents-toolkit` in Pi. Give it a work description and optionally name a skill for the child. The toolkit handles launches and continuations; separate reply skills return child results.

## What happens

The launcher defaults to `mode: interactive`, opening a visible terminal. Request `mode: auto` for background work that returns its result automatically. Both modes accept any requested skill; the skill does not determine model, effort, permissions, or execution mode. Choose `provider: claude`, `provider: chatgpt` (`codex` is an alias), or `provider: pi` independently.

Launch frontmatter contains `mode`, optional `skill`, and optional provider/model/effort/root overrides. For example:

```markdown
---
mode: auto
skill: websearch
---
Find primary sources for the proposed change.
```

Harness adds a native skill invocation only when `skill` is supplied. The parent includes it only when the user explicitly requests that skill by name. The child receives the work description, and its provider and project rules govern skill use. Missing requested skills fail before any child process or Aboard launch; the parent receives the failure. Install child workflows separately: subagents no longer installs prototype, websearch, grill-me, or issue-readers.

The toolkit starts by running its bundled `scripts/enable_inbox.py`. This explicitly creates and enables the conversation's inbox and returns its path. Repeated activation reuses the same assignment, including after resume. Startup, compaction, skill expansion and skill reads neither create an inbox nor inject inbox context. The toolkit contains the delegation instructions. Reply authorization stays internal rather than adding model context. Pi may show a user-facing reply-armed notice.

Availability currently checks conventional project/user skill directories for the child provider and working directory. Plugin namespaces and provider-configured resource locations outside these roots are not supported by this check. Native providers resolve the actual invocation. No task registry or specialized launcher is read; old custom registry files remain user-owned and are ignored.

An interactive child uses `reply-to-agent` to return its next successful response. On Pi, `/reply-to-agent-with-previous-message` sends its previous successful answer without another inference request. Its hook-backed skill shim is installed for Claude Code and ChatGPT. A toolkit request containing only `resume: agent-i` in frontmatter continues a child with its original provider, mode, model, effort, directory, and conversation; it does not re-invoke a skill or accept launch overrides. Existing stored task identities can still resume.

Claude/ChatGPT parents wait for pending replies in their Stop hook. An interactive Pi parent can finish its turn and wake when a reply arrives; a headless Pi parent waits before settling. While a parent works, Claude/ChatGPT receive replies through tool or Stop hooks; Pi queues replies after the current tools finish, before its next model request.

Launch and resume prompts preserve skill invocations while neutralizing native CLI commands such as `/resume` by removing their slash prefix. Explicit skills are added separately after sanitization, including through Aboard. Aboard Auto Run retains its own worker skills and exploration restrictions; manual delegation uses the general profile.

## Persistent commands

The package installs persistent session commands distinct from the catalogue installer:

```text
harness run --provider claude|chatgpt|pi [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible terminal. `ask` processes a parent's delegation inbox; `reply` arms an interactive child's next successful stop to return its result. `watch` follows a background child's recorded progress, while `--once` prints the progress recorded so far. Inside a parent, `agent-i` identifies a child.

## Configuration and troubleshooting

Configure launches in project `.harness/config.json` or user `~/.harness/config.json`. The first existing file wins; they are not merged. A minimal file is `{ "version": 1 }`. For example:

```json
{
  "version": 1,
  "providers": {
    "chatgpt": {
      "delegations": { "general": { "model": "gpt-6.1-sol", "effort": "high" } }
    }
  }
}
```

The shared file's `autoRun` settings belong to Aboard and are ignored by this runtime. `harness run` requires an explicit `--provider`. Provider entries can set a `command` and a `delegations.general` profile. This profile accepts `model` and `effort`; `"inherit"` uses native settings. Claude accepts full model IDs such as `claude-opus-5-5` as well as the native `opus`, `sonnet`, and `haiku` aliases. Claude can also set `deniedTools`. Explicit launch overrides take precedence. Skills do not select profiles. `session.stopWaitHours` sets an optional nonnegative wait for an outstanding reply. Session requests and logs live under `~/.harness/runtime/`; set `HARNESS_STATE_DIR` to change the Harness state root. If inbox activation fails, check that the updated runtime and the package's provider hook or extension are installed and active.

## Implementation and verification

`subagents` 2.10.0 (runtime 2.10.0) adds Pi as a provider of the existing Python runtime rather
than a second orchestrator. Requests, executions, process supervision, delivery claims and replay
stay in the shared SQLite state; a native extension translates Pi events into versioned
`harness-subagents-hook --pi` operations through `pi-transport` 1.1.0's bounded `requestCommand`.
The uv-installed entry point keeps the runtime's PyYAML dependency in its managed environment.

Children launch through the CLI process boundary, never the SDK: automatic work runs
`pi --mode json`, interactive work the terminal UI. Harness assigns the native ID with
`--session-id` for new sessions and continuations, and `--fork <id> --session-id <new>` when the
original session is still live, so resume never depends on the extension having loaded. Child
skills start as `/skill:<name> <prompt>` because Pi reads the skill name up to the first space.
The supervisor binds the JSON session header and decides success from Pi's events, because the
exit status ignores failed responses: the run must reach `agent_settled` unaborted, and the last
assistant message must end without `error`, `aborted` or `length` and contain text. Pi's
`--model` searches its whole catalogue, including unauthenticated providers, so a bare `haiku`
selected a Bedrock alias in manual testing. The runtime lists authenticated models with
`--list-models`, applies Pi's exact-then-alias matching, and launches the qualified
`provider/model`; unavailable or ambiguous models fail before launch. Effort maps to `--thinking`. RPC, run pools and the SDK were rejected:
a JSON run already matches the one-request child lifecycle, and live steering is not required.

Parent wake-up replaces the Claude/Codex Stop-hook wait. The runtime touches a per-parent
`results-ready` marker whenever a request settles; the extension stats it every 500 ms and rechecks
the database every 30 seconds. A terminal-UI or RPC parent delivers each claimed batch with
`pi.sendMessage`: idle parents start a turn, busy parents receive it as steering before their next
model call, matching PostToolUse delivery. A JSON or print parent, including an automatic child
that delegated further, waits in `agent_before_settle` and continues once with the result entry.
A delivery is acknowledged only after its `custom_message` entry carrying the delivery ID is
persisted; replay after reload or restart acknowledges an already persisted batch without
resending it. Delivery is session-wide rather than branch-bound, as with Claude/Codex rewinds,
so tree navigation cannot strand a child result.

Other boundaries: inbox activation is explicit through the toolkit's bundled script; no inbox
section is added to Pi's system prompt. Native tool completions, including failed commands and nested calls,
launch requests and append the launch status. `/reply-to-agent-with-previous-message`
sends the latest successful assistant text on the active branch without inference.
Interactive children report at `agent_settled`; a new prompt or failed turn expires an armed reply,
and quitting cancels an unanswered request. In-process `/new` and `/fork` sessions become unrelated
conversations. Loop implementers are rejected for Pi. Aboard accepts Pi delegations through its
native adapter and shared durable runtime. Headless children load project extensions only in trusted projects, so nested
delegation from automatic children needs project trust or a user-scope installation.

`npm run test:pi-subagents` installs the real catalogue package into an isolated uv tool environment,
with journeys for the checkout runtime (`--local`) and the shipped runtime pin, and drives real
Pi 1.2.0 on Windows against the fake Responses endpoint. A JSON parent
launches an automatic Pi child, waits before settlement and integrates its answer; an RPC parent
launches an interactive child, opened as an RPC session through a visible-terminal stand-in, whose
previous-message reply makes zero inference requests and starts the idle parent's next turn. Both
assert exact request counts, durable request state, acknowledged session-persisted delivery, native
session files and emptied inboxes. A checkout-runtime RPC regression also holds the parent in a real shell tool,
sends the child's previous answer, observes a claimed delivery while the parent is busy, and requires
the first model request after that tool to include the result. It checks zero inference for the reply
command, five total inference requests, one persisted and acknowledged delivery, and continuation of
the existing parent run. Unit tests cover argument construction, JSON success semantics
through a real supervisor run, discovery roots, bridge operations, delivery replay and the Aboard
payload. The Pi TUI itself, POSIX, and Claude/Codex parents with Pi children through real CLIs
are outside this gate. Interactive behavior has also been manually verified; that does not replace
these automated acceptance boundaries.

The task-free 3.0.0 checkout is verified by `e2e:subagents:skills` and `e2e:pi-subagents:skills` in `tests/e2e/`: real headless Claude/Codex/Pi CLIs use fake APIs to cover omitted/found/missing skills, native skill expansion, receipt writes, failure delivery, request counts, cleanup, and Claude/Codex resume. This does not certify the unchanged remote runtime pin or the visible Aboard/TUI paths.

The 3.0.7 checkout (runtime 3.0.4) removes additional delegation instructions, the child skill-use prefix, and model-facing reply-arming notices. The same real-CLI skill journeys pass for Claude/Codex/Pi. Regression tests cover ordinary parent and child turns after startup, resume, and compaction, plus silent reply authorization with pending nested results. The catalogue's remote runtime pin remains unchanged; these runtime fixes require a newly published pin before remote installs include them.

The 3.0.8 checkout (runtime 3.0.5, Pi toolkit 2.0.4) moves inbox allocation to explicit script activation.
The script delegates to the installed runtime so its Python dependencies stay in the uv-managed environment.
Claude uses `CLAUDE_CODE_SESSION_ID`, Codex uses `CODEX_THREAD_ID`, and Pi's extension supplies
`HARNESS_PI_SESSION_ID`; the runtime resolves each native ID to the registered Harness conversation.
Missing or unregistered identities fail without allocating an inbox. Allocation retains the existing six-character
random names and exclusive directory creation. Ordinary startup and toolkit invocation remain silent; only
previously enabled inboxes participate in request recovery. These changes also require a newly published
runtime pin for remote installations. The checkout passes the Claude/Codex skill-selection journeys,
including resume, and the Pi skill-selection journeys with five requests for no child skill, six for
a found skill and four for a missing skill. Claude/Codex also pass interactive, automatic,
alternate-root and interrupted-child recovery journeys. Unit tests cover silent startup,
explicit activation, repeated activation, native identity binding and pre-activation request isolation.

## Execution backends (3.1.0 checkout)

Provider selection and execution hosting are independent. `StandaloneBackend` owns native CLI
process launches; `BridgeBackend` implements the optional loopback execution-host protocol.
Neither the Sub-Agent runtime nor its payloads depend on a particular editor or application.
`harness run` continues to open a standalone terminal. Delegated launches first select an
available host, otherwise the standalone backend. Refusals, invalid inherited credentials,
timeouts and uncertain startup never trigger a second launch through another backend.

Execution hosts publish version-2 JSON records in `~/.harness/backends/endpoints/`, independently
of `HARNESS_STATE_DIR`. Records contain `host: "127.0.0.1"`, `port`, `workspaceRoot`,
`delegationToken`, `pid`, and `activatedAt`. Discovery rejects dead processes and mismatching
projects and prefers the newest applicable record. Loop continuations can match registered
sibling worktrees. A hosted parent passes `HARNESS_BRIDGE_PORT` and `HARNESS_BRIDGE_TOKEN`;
an incomplete inherited pair is an error rather than permission to fall back.

The host implements authenticated `POST /delegations` using
`runtime/src/subagents_runtime/schemas/bridge-delegation.schema.json`, returns `sessionId`,
`agentId` and `terminalId`, deduplicates `requestId`, and reports `startup-uncertain` when an
existing launch cannot safely be replayed. Lifecycle wrappers call `execution_host.started`
and `execution_host.exited`; they must not query runtime tables. Before submitting input to a
live child, the host calls `python -m subagents_runtime.terminal_resume` to bind reply ownership.
Bridge background streams retain the shared `runtime/watch/<execution-id>/stdout.jsonl` layout.

Additional Python backends register a factory in the `harness.subagents.backends` entry-point
group, installed in the runtime's managed environment. They implement `ExecutionBackend` in
`backends.py`: a stable name, live-continuation capability, effect-free `probe`, durable-reservation
`launch`, and `progress_path`. Extension backends precede the built-in bridge and standalone
fallback. Launch implementations must persist startup intent before effects and retain uncertainty
when they cannot prove that no process started. The public `execution_host` API provides
`reservation`, `starting`, `bind`, `rejected`, `started`, and `exited` so adapters do not need
SQL knowledge. `starting` atomically rejects a second launch intent. Backend names and opaque handles survive in
execution state; schema 11 migrates older host-handle columns without discarding saved sessions.

Aboard implements this neutral protocol and publishes its own adapter registration. Auto Run's
worker policy remains entirely on that side; no Auto Run engine change is needed. The 3.1.0
checkout requires coordinated runtime and extension publication: the catalogue's immutable runtime
and VSIX pins are unchanged and do not yet ship this refactor.

## Remaining integration limits

Pi context-usage telemetry remains unimplemented rather than estimated. Ordinary launch/reply/resume support does not enable Pi loop implementers for the unavailable `ship` workflow. On Pi, automatic loading of inline `@path` references requires the [file-mentions](file-mentions.md) extension to be installed and active in the child session. Without it, `@path` remains a valid file reference for the child to read explicitly; subagents alone does not attach its contents.

Checkout-runtime acceptance and immutable remote pins are separate. The existing native npm packaging checks recorded four shipped-pin journeys requiring the runtime changes from local commit `ba136dd`; rebuilding the extension archive does not itself publish that runtime. Keep remote-install claims scoped to the pin actually tested.
