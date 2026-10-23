# TODO(HITL)

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install todo-hitl`; see [installation and scope](../../getting-started.md).

## Use it

This package installs two skills in Claude Code, ChatGPT, and Pi. Invoke `/mark-as-todo-hitl`, `$mark-as-todo-hitl`, or Pi's `/skill:mark-as-todo-hitl` when code work must wait for a human decision. The agent adds a concise native-language comment such as `TODO(HITL): choose the retention period` at the relevant location and makes no other code changes.

## What happens

Invoke `/address-todo-hitl` or `$address-todo-hitl` when you are ready to resolve one. The agent finds the most important marker, investigates surrounding code and tests, and proposes a concrete resolution. It waits for your agreement before modifying code. After implementation and verification, it removes the marker only if its work is complete, then reports the next remaining marker, if any.

## Practical note

You can supply a marker or scope to `address-todo-hitl`. Without one, it ranks markers by impact, risk, and how much work they unblock. The marker stays in the code if the proposed resolution has not yet been agreed or completed.

## Pi usage

Use `/skill:mark-as-todo-hitl [task]`. Use `/skill:address-todo-hitl` to investigate a marker and agree on remediation before implementing it. Both shared skill entry points are installed.
