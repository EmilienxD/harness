---
name: aboard-e2e
description: Operate, diagnose, or extend aboard's deterministic Claude Code E2E harness, including its disposable GitHub fixture, reset lifecycle, local Anthropic-compatible server, real CLI smoke test, scenarios, and redacted diagnostics. Use for work under e2e/ or the aboard-e2e runtime repository; not for ordinary extension tests.
---

# Aboard deterministic E2E harness

Use this skill when running or changing the infrastructure in `e2e/`. The harness replaces only model inference. It deliberately retains the installed Claude Code CLI, its real `Read` and `Edit` tools, permission handling, process lifecycle, transcripts, hooks, and filesystem effects.

Do not change production aboard behavior or APIs for a harness-only task. In particular, do not globally configure `aboard.launch.claudeCommand` as `["claude", "-p"]`; Manager, brainstormer, HITL, takeover, and resume workflows need interactive Claude Code.

## Sources of truth

Read the relevant implementation before changing a boundary:

- `e2e/config.ts`: repository and external-runtime configuration.
- `e2e/repository.ts`: destructive bootstrap, operational reset, labels, ownership checks, and canonical seed creation.
- `e2e/server.ts`: loopback Anthropic-compatible HTTP and SSE behavior plus redacted observations.
- `e2e/scenario.ts`: declarative scenario, request parsing, history-derived transitions, stable IDs, and exact fixture contents.
- `e2e/smoke.ts`: Claude CLI compatibility check, isolated environment, process launch, and smoke assertions.
- `e2e/cli.ts`: command entry points.
- `e2e/fixture/repository/`: canonical repository contents. Keep this fixture minimal and free of `.abd`, `.claude`, credentials, generated state, and machine-specific paths.
- `test/e2e-harness.test.ts`: fast protocol, fail-closed, redaction, and environment tests.

The code and focused tests are authoritative for exact current behavior. Do not recreate protocol details from memory.

## Runtime configuration

Generated state stays outside the aboard checkout:

- `ABOARD_E2E_ROOT` defaults to `C:\Users\emb\dev\aboard-e2e-runtime`.
- `ABOARD_E2E_REPOSITORY` defaults to `EmilienxD/aboard-e2e`.
- The checkout is `<runtime root>\repository`.
- Claude state is `<runtime root>\claude-config`; keep it so later resume scenarios can reuse sessions.
- Structural diagnostics and the readiness and ownership records also live under the runtime root.
- `ABOARD_E2E_RECREATE` is used only by destructive bootstrap and must exactly equal the configured full repository slug.

Never put generated Claude configuration, request records, runtime clones, transcripts, or credentials in the aboard checkout.

## Commands

Build the harness automatically through its public commands:

```powershell
npm run e2e:bootstrap
npm run e2e:reset
npm run e2e:serve
npm run e2e:smoke
```

- `e2e:bootstrap` is the one-time destructive repository recreation and seed.
- `e2e:reset` performs the repeatable remote and local operational reset.
- `e2e:serve` runs only the local fake Anthropic endpoint and prints its ephemeral connection data to the invoking terminal.
- `e2e:smoke` resets the local verified clone, launches the server and real CLI, validates the exchange, and intentionally leaves the edited fixture for inspection. A subsequent `e2e:reset` restores it.

## Destructive bootstrap

Bootstrap deletes and recreates the configured GitHub repository. Run it only when the user explicitly asks to recreate the disposable E2E repository or the task specifically requires the one-time bootstrap. Do not infer authorization from a request to run routine E2E tests.

The command must enforce all of these preconditions before deletion:

- active GitHub account is `EmilienxD`;
- configured and resolved repository is exactly `EmilienxD/aboard-e2e`;
- existing repository is private;
- `ABOARD_E2E_RECREATE` exactly equals the full slug;
- the active `gh` credential has `delete_repo`.

If the scope is absent, stop and report this exact prerequisite:

```powershell
gh auth refresh -h github.com -s delete_repo
```

For an authorized bootstrap invocation:

```powershell
$env:ABOARD_E2E_RECREATE = "EmilienxD/aboard-e2e"
npm run e2e:bootstrap
Remove-Item Env:ABOARD_E2E_RECREATE
```

An empty newly recreated GitHub repository can report `defaultBranchRef.name` as `""`. This is valid only before the seed push; the final default branch must be `main`.

The seed commit is reproducible: fixed fixture bytes, author and committer identity, timestamp, subject, LF handling, no signing, and no user hooks. Changing fixture bytes or seed metadata deliberately changes the canonical commit SHA.

## Operational reset

Reset is destructive within the dedicated harness repository and verified external clone. It must fail before remote mutation if repository or local ownership does not match the configured slug and path.

It performs and verifies this outcome:

- close open pull requests without merging;
- close open issues;
- force `main` to the canonical seed using the observed remote ref as a lease;
- delete every non-`main` branch using its observed ref identity;
- retain exactly the eight current `[AI]-*` labels and remove all other test labels;
- clone when absent, or fetch, prune, clean, and hard-reset only the ownership-recorded checkout;
- finish on clean local `main`, exact `origin`, one remote `main`, no other branches, and no open issues or pull requests.

Issue and pull request numbers are generated output, never fixture constants.

The ownership record and exact GitHub origin are safety boundaries. Do not weaken them for convenience. An altered origin must make reset refuse before it closes issues, pull requests, or changes refs.

## Fake Anthropic server

The server must remain a loopback-only inference emulator with no forwarding path:

- bind an ephemeral port on `127.0.0.1`, never `0.0.0.0`;
- generate a dummy bearer value per run;
- require it for JSON API requests;
- return unauthenticated `204` for Claude Code's best-effort `HEAD /api/hello` warm-up probe;
- route `POST /v1/messages` by pathname, ignoring query differences such as `?beta=true`;
- implement `POST /v1/messages/count_tokens` with a fixed plausible count;
- support streaming SSE and aggregate non-streaming Messages responses;
- do not implement model discovery unless a scenario explicitly enables `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.

Validate stable invariants: JSON content type, bearer authentication, `anthropic-version: 2023-06-01`, nonempty model, message history shape, scenario marker, available tools, known tool/result IDs, checkpoint ordering, tool failures, and fixture path containment. Accept unknown headers, beta names, request fields, message roles, and irrelevant block fields for forward compatibility. Claude Code 2.1.261 inserts `system` messages between tool turns.

Streaming success order is:

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

Use one content block and one tool call per response in the foundational scenario. Anthropic SSE does not use a terminal `[DONE]` record.

The response is a pure function of scenario plus complete request history. Repeated identical histories must produce identical message and tool IDs. Never select responses from a mutable global request counter.

Unexpected routes or histories must fail closed with a deterministic structural error. Diagnostics may name a sanitized JSON path and hashes but must not echo request text, tool-result content, tool inputs, raw IDs, session IDs, credentials, or response contents.

## Foundational scenario

Keep scenario manifests declarative. They may describe selectors, history conditions, tool names and inputs, final text, and expected fixture results. They must not execute mutation callbacks; Claude Code itself executes the tools.

The current scenario is selected by `[E2E:single-file-success]` and has three history-derived checkpoints:

1. Initial history offers `Read` and `Edit` and produces a stable `Read` call for `${REPO_ROOT}\deterministic.txt`.
2. A matching successful `Read` result containing the before marker produces a stable `Edit` call with the expanded absolute path and exact replacement.
3. A matching successful `Edit` result produces final text with `end_turn` and exactly one valid `<commit>` marker.

Tool results must immediately follow the corresponding assistant tool-use turn. In a user block array, tool results precede text. Do not match Claude Code's incidental line-number formatting more tightly than needed to prove the expected fixture marker was read.

## Real Claude Code launcher

The smoke test requires installed Claude Code `>= 2.1.261` and checks required help structures before launch. Protocol drift must produce a structural compatibility failure; do not silently adapt to a newer incompatible CLI.

Launch with the real executable, lowercase `-p`, session persistence, and no `--bare`:

```text
-p
--output-format stream-json
--verbose
--tools Read,Edit
--allowedTools Read,Edit
--permission-mode acceptEdits
--permission-prompts none
--session-id <generated UUID>
```

The child uses the verified fixture clone as its working directory and an isolated `CLAUDE_CONFIG_DIR`. Set the local base URL and generated dummy `ANTHROPIC_AUTH_TOKEN`, disable nonessential traffic and updates, and set ordinary retries to zero. Remove inherited direct API keys, OAuth, custom headers, retry watchdog, gateway discovery, and Bedrock, Vertex, Foundry, Mantle, AWS, and Azure provider selectors and credentials.

Smoke succeeds only when:

- Claude exits zero;
- all three inference checkpoints are reached exactly once with no rejected or unexpected request;
- the real `Read` result drives the second request;
- the real `Edit` result drives the third request;
- the final stream contains the expected response;
- `deterministic.txt` has the exact after bytes;
- `git status --porcelain` reports only `M deterministic.txt`.

Keep the 120-second process timeout bounded. Do not add Bash, networking, clocks, package managers, background tools, parallel calls, or subagents to this foundational smoke.

## Diagnostics and sensitive data

Request bodies and prompt contents remain in memory only. Persist only structural observations: method, endpoint, query keys, salted session hash, API version, beta names, model, stream mode, roles, block types, offered tool names, request hash and size, checkpoint, status, and sanitized failure detail.

Never persist or print authorization values, API keys, cookies, environment dumps, system/user/assistant text, thinking, tool-result content, full tool inputs, transcripts, or raw request/response bytes. The diagnostics document must retain `upstreamMode: "forbidden"`; the emulator must never gain a proxy or upstream mode.

The standalone `e2e:serve` command prints its generated dummy bearer value for a caller to use. That terminal-only output is intentional; it must not enter persisted diagnostics or the repository.

## Extending or diagnosing the harness

For an ordinary change:

1. Read the affected files and focused tests listed under Sources of truth.
2. Keep parsing and transition logic testable without GitHub or the real CLI.
3. Add or adjust a focused test for observable protocol or safety behavior.
4. Run `npm run check` and the focused bundled test.
5. Run `npm test` and `npm run build`.
6. Run external reset/smoke verification when the change touches repository lifecycle, server compatibility, environment routing, or CLI behavior.

When a real smoke fails, inspect the redacted structural diagnostics, clone status and exact fixture bytes first. Do not inspect or publish the retained Claude transcript unless the task explicitly requires transcript analysis. A newer protocol incompatibility should stop with a useful structural mismatch. Do not introduce a paid interception capture without separate explicit authorization.

Use the checked-in Claude Code references under `docs/CLAUDE-REFERENCES/` when changing CLI, tool, settings, hook, session, or gateway behavior. Use current official Anthropic documentation when an API contract needs verification.

## Full verification

After an authorized repository-lifecycle or protocol change, verify in this order:

```powershell
npm run check
npm test
npm run build
npm run e2e:reset
npm run e2e:reset
npm run e2e:smoke
npm run e2e:reset
```

Confirm after the two resets and final reset:

- remote is private and resolves to the configured full slug;
- remote exposes only canonical `main` through ordinary branch refs;
- local clone is clean on `main` and matches `origin/main`;
- there are no open issues or pull requests;
- there are exactly eight expected `[AI]-*` labels.

Confirm during smoke that only the fixture file changes and every inference call reaches the loopback server with the dummy bearer. Check persisted diagnostics for forbidden prompt, transcript, token, credential, fixture, and final-response contents.

For a deliberate origin-refusal test, record the verified origin, temporarily set a different GitHub origin, run reset and require a nonzero refusal, then restore the exact recorded origin and run reset successfully. Never leave the clone pointed at the altered origin.

The fast test suite already sends an unexpected request history and verifies a deterministic redacted rejection. Preserve that coverage when changing history parsing.
