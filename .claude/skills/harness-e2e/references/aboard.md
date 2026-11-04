# Aboard E2E adapter

Read this reference for work under apps/aboard/test/e2e/ or against the disposable harness-e2e repository.

## Ownership and sources

Aboard consumes the Harness core; it does not own generic Claude/Codex launch or Anthropic transport code.

- apps/aboard/test/e2e/config.ts: Aboard repository/runtime configuration.
- apps/aboard/test/e2e/repository.ts: bootstrap, reset, labels, ownership, and canonical seed.
- apps/aboard/test/e2e/scenario.ts: Aboard Claude scenario catalog and history transitions.
- apps/aboard/test/e2e/server.ts: thin wiring to e2e/core/anthropic-server.ts.
- apps/aboard/test/e2e/smoke.ts: fixture assertions using e2e/core/claude.ts.
- apps/aboard/test/e2e/codex-server.ts: Aboard-specific Responses scenarios for lifecycle, guards, reviews, and Auto Run.
- apps/aboard/test/e2e/chatgpt.ts: Aboard ChatGPT journey using shared Codex helpers.
- apps/aboard/test/e2e/vscode/: extension-host and Auto Run journeys.
- apps/aboard/test/e2e/fixture/repository/: canonical minimal repository bytes.
- apps/aboard/test/unit/e2e-*.test.ts: fast adapter, protocol, safety, and redaction tests.

Keep Aboard markers, GitHub orchestration, VS Code behavior, and canonical fixtures here. Put reusable protocol validation, loopback transport, CLI isolation, and process execution in e2e/core/.

## Runtime

- ABOARD_E2E_ROOT defaults to `aboard-e2e-runtime` under the OS temporary directory.
- ABOARD_E2E_REPOSITORY defaults to EmilienxD/harness-e2e.
- The verified checkout is <runtime root>\repository.
- Claude state is <runtime root>\claude-config.
- Diagnostics, readiness, ownership, ChatGPT state, and worktrees remain below the runtime root.
- ABOARD_E2E_RECREATE is bootstrap-only and must equal the full repository slug.

Never place generated config, runtime clones, transcripts, request records, or credentials in either checkout.

## Commands

Run from apps/aboard/:

~~~powershell
npm run e2e:bootstrap
npm run e2e:reset
npm run e2e:serve
npm run e2e:smoke
npm run e2e:chatgpt
npm run e2e:extension
npm run e2e:auto-run
npm run e2e:full
~~~

Bootstrap recreates the repository and is not routine verification. Reset restores canonical remote/local state. Serve exposes the Aboard Claude scenarios through the shared transport. Smoke runs real Claude Read/Edit. ChatGPT runs lifecycle, resume, failure, sandbox, worker, browser, and review paths through real Codex. Extension runs the real VS Code host. Auto Run creates fresh issues and exercises real visible Claude and Codex workers. Full is the authoritative matrix and ends with reset.

## Bootstrap safety

Bootstrap deletes and recreates a GitHub repository. Run it only when the user explicitly asks to recreate the fixture.

Before deletion it must verify the active account is EmilienxD, the exact slug is EmilienxD/harness-e2e, the repository is private, ABOARD_E2E_RECREATE exactly matches, and the credential has delete_repo.

If scope is missing, report:

~~~powershell
gh auth refresh -h github.com -s delete_repo
~~~

For an authorized bootstrap:

~~~powershell
$env:ABOARD_E2E_RECREATE = "EmilienxD/harness-e2e"
npm run e2e:bootstrap
Remove-Item Env:ABOARD_E2E_RECREATE
~~~

Keep the seed reproducible: fixed bytes, identity, timestamp, subject, LF handling, no signing, and no user hooks.

## Reset safety and postconditions

Reset must refuse before remote mutation if the slug, origin, runtime path, or ownership record is wrong. It may remove only Git-registered worktrees below <runtime root>\worktrees.

A successful reset closes open PRs without merging and closes issues; force-updates main using the observed ref as a lease; deletes non-main branches by observed identity; retains exactly seven expected [AI]-* labels; resets only the ownership-recorded checkout; and finishes with clean local main equal to origin/main, only remote main, and no open issues or PRs.

Issue and PR numbers are generated output. Never weaken origin, lease, containment, or ownership checks.

## Scenario constraints

The foundational Claude scenario is history-derived: real Read result, real Edit result, then final text. Keep results immediately after matching tool uses, user tool-result blocks before text, stable IDs, and exact path containment.

Auto Run uses fresh issue numbers and restores the repository in finally. The fake model reads before editing. Resolve worktree paths from the one active Git-registered worktree; never edit the original checkout to avoid a prompt. Preserve narrow worker mutation policy rather than granting broad shell access.

Do not globally change Aboard production launch commands for E2E. Interactive, explore, address, review, resume, HITL, and takeover paths rely on their authored interactive CLI shapes.

## Verification

For an ordinary adapter change, run npm run check, focused tests, npm test, npm run build, and the affected real journey. For lifecycle, protocol, environment-routing, or repository changes, run npm run e2e:full.

After final reset, confirm the private exact slug, canonical main, clean matching clone, no other branches, no open issues or PRs, and exactly seven expected labels. Check diagnostics for forbidden prompt, transcript, token, credential, fixture, and response content.
