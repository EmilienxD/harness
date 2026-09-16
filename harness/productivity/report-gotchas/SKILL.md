---
name: report-gotchas
description: Report consequential caveats remaining after implementation. Use when incomplete verification, failures, risks, or unrelated problems require the user's attention.
argument-hint: "[gotchas to report]"
license: MIT
metadata:
  author: EMB
---

# Report Gotchas

After completing an ambiguous task, if there are remaining gotchas, caveats, unverified work, unrelated errors, bugs, failed tests, or incomplete work, notify the user by submitting a Markdown gotcha report.

Never report a gotcha already reported during the session. Finish normally without submitting a report if there are no new gotchas to report.

Run this command once per gotcha:

```bash
harness-report-gotchas submit <<'HARNESS_GOTCHAS'
**Short task or result**

## Caveats

- This notification describes a concrete caveat and its consequence.
HARNESS_GOTCHAS
```

Prefer a quoted heredoc (or a literal here-string if your shell uses PowerShell). Run multiple parallel shell tool calls if you have multiple gotchas to report.

Start with a short, one-line, bold title that clearly identifies the task or result. Be concise and concrete so the user can understand it quickly.

Keep secrets out of the report. The system adds the session ID, time, working directory, and local Git status; omit those from the report.

Treat a `HARNESS_REPORT_GOTCHAS_RECEIPT` response as a successful submission. If submission fails, preserve the same information in the final response and state that Discord reporting failed.

After reporting something, do not describe it again in your end-of-turn message; tell the user you reported some gotchas and give the titles you used to identify them.
