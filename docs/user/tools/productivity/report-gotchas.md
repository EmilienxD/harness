# Report gotchas

## Use it

`report-gotchas` reports consequential caveats remaining after implementation to a Discord channel: failed checks, incomplete verification, unresolved risks, or human action required. It sends nothing when there is no new caveat. Install the package for your agent platform, then configure a Discord incoming webhook with `harness-report-gotchas configure`; input is hidden. The URL is stored in `~/.harness/report-gotchas/config.json`. Keep it private because anyone holding it can post to that channel.

## Manual reports and configuration

You can invoke `/report-gotchas` in Claude Code or `$report-gotchas` in ChatGPT. For a manual report, pipe Markdown to `harness-report-gotchas submit`, or run `harness-report-gotchas submit -m "**Task**: concrete issue and consequence."`. The command posts only the supplied Markdown and waits for Discord to confirm delivery. It prints "Report successfully posted to Discord." on success and exits with an error if posting fails. Keep secrets out of the report. `HARNESS_REPORT_GOTCHAS_STATE_DIR` changes its state directory; `HARNESS_REPORT_GOTCHAS_WEBHOOK_URL` supplies the webhook through the environment.

## Practical note

A useful report names the task, then lists specific caveats and their consequences. Avoid resubmitting an issue already reported in the same session; when delivery fails, keep the caveat in the agent's final response so it is still visible.
