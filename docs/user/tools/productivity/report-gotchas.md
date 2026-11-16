# Report gotchas

Platforms: **Claude Code, ChatGPT, Pi**.

Send important remaining caveats to a Discord channel. Install with `harness install report-gotchas`. See [Get started](../../getting-started.md) for provider options.

## When to use it

Report failed checks, unresolved risks, incomplete work, or follow-up that needs human attention. Use it when the person monitoring the work is not watching the agent session.

## Set up and use

Create a Discord incoming webhook for the destination channel. Keep the webhook URL private. Anyone with it can post to that channel. Set `HARNESS_REPORT_GOTCHAS_WEBHOOK_URL` in the environment that launches your agent. Install Python 3.11 or newer and allow network access to Discord. Invoke `/report-gotchas` in Claude Code, `$report-gotchas` in ChatGPT, or `/skill:report-gotchas` in Pi.

Review what you authorize the agent to send. Keep secrets out of reports. No report is sent when there is no new caveat.
