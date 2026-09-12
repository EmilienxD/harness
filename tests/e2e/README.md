# Harness E2E core

This directory owns the reusable deterministic E2E infrastructure for Harness tools and apps. It runs the real Claude Code or Codex CLI while replacing only model inference with a loopback endpoint.

## Ownership boundary

- `core/anthropic-protocol.ts` validates the forward-compatible Messages request envelope.
- `core/anthropic-server.ts` owns the authenticated loopback Anthropic transport, SSE responses, fail-closed routing, and redacted structural diagnostics. Callers supply scenario selection and transitions.
- `core/claude.ts` owns Claude CLI compatibility checks, provider-isolated environments, bounded process execution, and stream-json parsing.
- `core/codex.ts` owns Codex CLI compatibility checks, deterministic `CODEX_HOME` creation, and bounded process execution.
- `tools/<tool>/` owns a tool-specific scenario and journey. It may use the checked-in tool payload but must not depend on an app.

App-specific repository fixtures, GitHub lifecycle, extension-host journeys, and scenario catalogs stay with their app. Aboard's adapter is in `apps/aboard/test/e2e/`.

Generated config, transcripts, diagnostics, and fixture checkouts must remain outside the repository. Endpoint diagnostics contain structure only and retain `upstreamMode: "forbidden"`.

## Commands

From this directory:

```powershell
npm install
npm run check
npm test
npm run e2e:on-edit-block
npm run e2e:no-new-documents
npm run e2e:report-gotchas
```

The `on-edit-block` journey stages the actual shipped hook in a temporary project, launches the installed Claude CLI, and proves that the hook denies an edit until its required guide has been supplied, after which the retry succeeds.

The `no-new-documents` journey stages the actual shipped cross-platform hook,
launches the installed Claude Code and Codex CLIs against authenticated
loopback inference servers, and proves that a new file under a nested `docs/`
directory is denied while the final response reports the proposed document and
its rationale.

The `report-gotchas` journey is an opt-in live external test. It stages the
shipped skill and runtime outside the repository, drives both real provider
CLIs through loopback inference, and sends one identifiable report per provider
to the configured Discord webhook. Configure the webhook with
`harness-report-gotchas configure` before running it. The default `npm test`
suite skips these two live cases unless
`HARNESS_REPORT_GOTCHAS_LIVE_E2E=1` is set.
