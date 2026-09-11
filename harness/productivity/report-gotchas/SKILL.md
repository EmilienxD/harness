---
name: report-gotchas
description: Report noteworthy post-implementation handoff gotchas to the user's Discord history. Use near the end of complicated implementation work when the handoff has any gotchas, caveats, unverified work, unrelated errors, bugs, failed tests, unfinished work, or required human action; skip when none exist.
allowed-tools: Bash(harness-report-gotchas submit *) PowerShell(harness-report-gotchas submit *)
---

# Report Gotchas

Before the final response, audit the completed work for every category below. When every category is empty, finish normally without submitting a report. When any category is nonempty, submit one compact Markdown report in a single shell-tool call.

Start with a short bold line identifying the task or result. Include only nonempty sections, preserving concrete file names, commands, errors, and next actions:

- `⚠️ Gotchas`
- `🪨 Caveats`
- `🔍 Unverified work`
- `🧯 Unrelated errors`
- `🐛 Bugs`
- `🧪 Failed tests`
- `🚧 Unfinished work`
- `🙋 Human action required`

Keep credentials, tokens, webhook URLs, and other secrets out of the report. The runtime adds the session ID, time, working directory, and local Git status; omit those from the Markdown.

On POSIX shells, submit through a quoted heredoc:

```bash
harness-report-gotchas submit <<'HARNESS_GOTCHAS'
**Short task or result**

## ⚠️ Gotchas

- Concrete detail and its consequence.
HARNESS_GOTCHAS
```

On PowerShell, submit through a literal here-string:

```powershell
@'
**Short task or result**

## ⚠️ Gotchas

- Concrete detail and its consequence.
'@ | harness-report-gotchas submit
```

Use the shell form native to the current environment. Treat a `HARNESS_REPORT_GOTCHAS_RECEIPT` response as successful submission. If submission fails, preserve the same information in the final response and state that Discord reporting failed.
