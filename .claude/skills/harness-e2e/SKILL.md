---

name: harness-e2e

description: Operate, diagnose, or extend Harness's deterministic real-CLI E2E infrastructure and tool journeys, including Aboard's adapter and the shared disposable GitHub fixture. Use for work under root tests/e2e/, apps/aboard/e2e/, or the harness-e2e runtime; not for ordinary unit or extension tests.

---

**# Harness deterministic E2E**

Harness owns the reusable E2E core. It replaces only model inference and deliberately retains the installed Claude Code or Codex CLI, real tools, hooks, permissions, process lifecycle, and filesystem effects. App adapters provide their own scenarios and external fixtures.

Do not change production behavior or APIs to satisfy a harness-only test. Keep generated configuration, transcripts, diagnostics, fixture checkouts, and credentials outside the repository.

**## Choose the boundary**

Read the implementation at the boundary being changed:

* `tests/e2e/core/anthropic-protocol.ts`: forward-compatible Messages request validation and protocol errors.

* `tests/e2e/core/anthropic-server.ts`: authenticated loopback Anthropic transport, SSE, fail-closed routing, readiness, and redacted observations.

* `tests/e2e/core/claude.ts`: Claude CLI compatibility, provider isolation, bounded launch, and stream-json parsing.

* `tests/e2e/core/codex.ts`: Codex CLI compatibility, deterministic `CODEX_HOME`, bounded launch, and redaction.

* `tests/e2e/core/path.ts`: cross-platform path containment.

* `tests/e2e/tools/<tool>/`: a tool-owned scenario, real-CLI journey, and CLI entrypoint. Tool journeys may consume the checked-in tool payload but must not depend on an app.

* `tests/e2e/test/`: public-boundary tests for reusable journeys.

* `tests/e2e/README.md`: current ownership and commands.

* `apps/aboard/e2e/`: Aboard-only repository lifecycle, fixture, scenario catalog, Responses endpoint scenarios, extension hosts, bridge lifecycle, and Auto Run orchestration.

For Aboard work, read [references/aboard.md](references/aboard.md) before changing its adapter, runtime repository, or external journeys.

The implementation and focused tests are authoritative for exact current protocol behavior. Do not reconstruct CLI or endpoint details from memory.

**## Core invariants**

Inference endpoints must:

* bind an ephemeral port on `127.0.0.1`, never a public interface;

* generate a dummy bearer per run and reject unauthenticated JSON requests;

* have no forwarding, proxy, or paid-upstream mode;

* derive responses from the complete request history, not a mutable request counter;

* fail closed on unknown routes, histories, tool IDs, ordering, or fixture escapes;

* accept irrelevant future fields while validating stable envelope and tool invariants;

* keep prompt and response bodies in memory only.

Persist structural diagnostics only: endpoint shape, salted session hash, model, roles/block types, offered tool names, request hash and size, scenario/checkpoint, status, and sanitized failure detail. Never persist or print prompts, thinking, tool results, tool inputs, transcripts, raw IDs, cookies, tokens, credentials, or raw request/response bodies. Diagnostics must retain `upstreamMode: "forbidden"`.

Real CLI launchers must use isolated provider configuration, clear inherited paid-provider credentials and selectors, disable updates and nonessential traffic, set retries to zero, and keep process timeouts bounded. Protocol drift should fail with a structural compatibility error instead of silently adapting.

**## Adding a tool journey**

Keep each journey as a vertical public-boundary test:

1. Put its deterministic scenario and runner under `tests/e2e/tools/<tool>/`.

2. Stage the actual shipped tool payload in a temporary external project.

3. Start the shared endpoint with the tool's parser/transition callbacks.

4. Launch the real CLI through the shared launcher.

5. Assert observable checkpoints, exact filesystem effects, and zero unexpected requests.

6. Clean only the exact temporary root created by the journey.

Scenario transitions describe model responses; the real CLI must execute mutations. Use stable tool/message IDs derived from scenario state. A scenario should request the minimum tools needed and should not add networking, clocks, package managers, background processes, or subagents unless the behavior under test requires them.

From `tests/e2e/`:

```powershell
npm run check

npm test

npm run e2e:on-edit-block
```

`npm test` currently includes the real `on-edit-block` journey: it reads the target, observes one hook denial carrying the required guide, retries the edit, and verifies exact final bytes.

**## Diagnosing failures**

Inspect redacted structural diagnostics, endpoint checkpoints, process exit, and exact fixture bytes first. Do not inspect or publish retained transcripts unless the task explicitly requires transcript analysis. Preserve an unexpected-history test proving deterministic redacted rejection.

Use checked-in official references under `docs/CLAUDE-REFERENCES/` and `docs/CHATGPT-REFERENCES/` when changing CLI flags, hooks, settings, sessions, sandboxing, or gateway behavior.

**## Verification scope**

For core or tool changes, run the root E2E check and focused journey, then any consuming adapter's checks. For Aboard lifecycle, protocol, environment-routing, or repository changes, use the full sequence in [references/aboard.md](references/aboard.md).

Destructive bootstrap is never implied by routine E2E verification. It requires explicit user authorization and the exact safety preconditions in the Aboard reference.
