#!/usr/bin/env python3
"""Claude Code UserPromptSubmit adapter for the shared issues publisher."""
from __future__ import annotations

import json
import sys

import issues_core as core


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()

    if core.PROMPT_PATTERN.match(prompt):
        dry = "--dry" in prompt.split()
        session_id = str(payload.get("session_id") or "")
        result = core.publish_issues(dry, session_id)
        sys.stderr.write("\n\n" + result)
        raise SystemExit(2)

    try:
        notice = core.flush_notice()
    except Exception:  # noqa: BLE001 - never block a prompt over a notice
        notice = None

    if notice:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": notice,
                }
            },
            sys.stdout,
        )


if __name__ == "__main__":
    main()
