# Report Gotchas

Report Gotchas gives Claude Code and Codex a model-invokable skill that sends noteworthy handoff details to one Discord channel. The agent submits Markdown through stdin in one tool call. A post-tool hook then attaches the authoritative provider session ID, UTC timestamp, working directory, and local Git state before an independent worker posts the report.

Successful reports are deleted locally after Discord confirms every message. Long reports are split and sent sequentially. Transient delivery failures retry automatically, resuming after the last confirmed message so already-delivered chunks are not repeated. Reports that still cannot be delivered remain in `~/.harness/report-gotchas/queue/`; run `harness-report-gotchas retry` to deliver them later.

## Discord setup

Create an incoming webhook for the destination Discord channel, then run:

```console
harness-report-gotchas configure
```

Paste the webhook URL at the hidden prompt. The URL is stored in the user-owned `~/.harness/report-gotchas/config.json`, rather than in a repository or agent prompt. Any already-queued reports are delivered after configuration. `HARNESS_REPORT_GOTCHAS_WEBHOOK_URL` can supply the URL instead for managed environments.

Discord webhooks can mention users and roles by default. This runtime disables all mention parsing for report messages.
