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
npm run e2e:on-edit-reminder
npm run e2e:on-read-reminder
npm run e2e:no-new-documents
npm run e2e:prefer-edit-tool
npm run e2e:prefer-fewer-comments
npm run e2e:prefer-read-tool
npm run e2e:report-gotchas
```

The `on-edit-block` journey stages the actual shipped hook in a temporary project, launches the installed Claude CLI, and proves that the hook denies an edit until its required guide has been supplied, after which the retry succeeds.

The `on-edit-reminder` journey stages the shipped Claude hook, lets the first
edit land, verifies that its additional context requires the mapped guide,
then proves that the real CLI reads the guide and corrects the file.

The `on-read-reminder` journey stages the shipped Claude hook and proves that a
matched read returns the mapped required-reading reminder before the real CLI
reads that guide.

The `no-new-documents` journey stages the actual shipped cross-platform hook,
launches the installed Claude Code and Codex CLIs against authenticated
loopback inference servers, and proves that a new file under a nested `docs/`
directory is denied while the final response reports the proposed document and
its rationale.

The `prefer-edit-tool` and `prefer-read-tool` journeys exercise their shipped
Claude-only hooks through real Bash calls. They prove that the shell operation
still completes while its result carries the corresponding native-tool nudge.

The `prefer-fewer-comments` journey stages the shipped cross-platform hook and
uses real Claude Code and Codex CLIs to write an over-budget Python comment. It
proves the write remains on disk and both providers receive the hook's
forward-looking comment-budget reminder.

The `report-gotchas` journey is an opt-in live external test. It stages the
shipped skill and runtime outside the repository, drives both real provider
CLIs through loopback inference, and sends one identifiable report per provider
to the configured Discord webhook. Configure the webhook with
`harness-report-gotchas configure` before running it. The default `npm test`
suite skips these two live cases unless
`HARNESS_REPORT_GOTCHAS_LIVE_E2E=1` is set.
