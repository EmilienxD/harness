---
name: report-gotchas
description: Report consequential caveats remaining after implementation. Use when incomplete verification, failures, risks, or unrelated problems require the user's attention.
argument-hint: "[gotchas to report]"
license: MIT
metadata:
  author: EMB
---

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

Prefer a quoted heredoc or here-string.with `harness-report-gotchas submit -m`. Run multiple parallel commands if you have multiple gotchas to report.

Start with a short, one-line, bold title that clearly identifies the task or result. Be concise and concrete so the user can understand it quickly.

Keep secrets out of the report.

The command waits for Discord to confirm the post. If it fails, preserve the gotcha in the final response and state that Discord reporting failed.

After reporting something, do not describe it again in your end-of-turn message; tell the user you reported some gotchas and give the titles you used to identify them.
