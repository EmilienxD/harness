# Report gotchas

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install report-gotchas`; see [installation and scope](../../getting-started.md).

## Use it

`report-gotchas` reports consequential caveats remaining after implementation to a Discord channel: failed checks, incomplete verification, unresolved risks, or human action required. It sends nothing when there is no new caveat. Install the skill for your agent platform, then configure a Discord incoming webhook with uv and Git on PATH:

```sh
uvx --from git+https://github.com/EmilienxD/harness@65afc165c07b7894c8adc0013e52896fbc79279d#subdirectory=harness/productivity/report-gotchas/runtime harness-report-gotchas configure
```

Input is hidden. The URL is stored in `~/.harness/report-gotchas/config.json`. Keep it private because anyone holding it can post to that channel. Use the same uvx prefix for every CLI command below. The first run downloads and builds the pinned package; later runs reuse uv's cache. Sandboxed providers need network access for acquisition and Discord, plus write access to uv's cache.

## Manual reports and configuration

You can invoke `/report-gotchas` in Claude Code, `$report-gotchas` in ChatGPT, or `/skill:report-gotchas` in Pi. For a manual report, pipe Markdown to `harness-report-gotchas submit`, or run `harness-report-gotchas submit -m "**Task**: concrete issue and consequence."`. The command posts only the supplied Markdown and waits for Discord to confirm delivery. It prints "Report successfully posted to Discord." on success and exits with an error if posting fails. Keep secrets out of the report. `HARNESS_REPORT_GOTCHAS_STATE_DIR` changes its state directory; `HARNESS_REPORT_GOTCHAS_WEBHOOK_URL` supplies the webhook through the environment.

## Practical note

A useful report names the task, then lists specific caveats and their consequences. Avoid resubmitting an issue already reported in the same session; when delivery fails, keep the caveat in the agent's final response so it is still visible.

## Implementation and verification

The `report-gotchas` 2.1.0 checkout installs one provider-neutral model-invoked skill;
`harness-report-gotchas` runs on demand through uvx. Pi needs no extension, transport dependency or reporting tool.
Skills install in the conventional skills directory. All providers run the same CLI.

`submit` posts the supplied Markdown directly with Discord's `wait=true` and waits for a
created-message response. It prints "Report successfully posted to Discord." only after
all parts are confirmed. Reports longer than Discord's message limit are split in memory;
mentions are disabled. A failed post exits nonzero, identifies any already-posted parts,
and leaves the caveat for the agent's final response. Requests have a ten-second timeout.
There are no background workers, local report files, queues, receipts, provider/session/Git
metadata, retry command, hook fragments, migration or compatibility paths. `configure`
stores only the webhook configuration; submitting a report writes no local state.

The live journey was verified through real headless Claude Code, Codex and Pi, fake model
inference, and the configured real Discord webhook. Each provider made exactly three model
requests. The user confirmed all three notifications arrived. Local HTTPS fixture journeys
add project/user and JSON/RPC coverage, missing configuration, empty reports, Unicode,
mention suppression, multipart posts, HTTP failures and rate limits. They verify real CLI
exit status and Discord effects without prompt-text assertions or mocked runtime functions.

Local HTTPS journeys execute the skill's published immutable runtime pin through uvx with isolated caches and no installed host CLI. Pi TUI and POSIX remain outside the Windows headless gate.
