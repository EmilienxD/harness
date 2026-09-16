#!/usr/bin/env python3
"""Claude Code UserPromptSubmit adapter for the shared issues publisher."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import issues_core as core


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()
    cwd = Path(str(payload.get("cwd") or ".")).resolve()

    if core.PROMPT_PATTERN.match(prompt):
        dry = "--dry" in prompt.split()
        session_id = str(payload.get("session_id") or "")
        result = core.publish_issues(dry, session_id)
        sys.stderr.write("\n\n" + result)
        raise SystemExit(2)

    contexts: list[str] = []
    try:
        notice = core.flush_notice(cwd / core.GATEWAY_DIR)
    except Exception:  # noqa: BLE001 - never block a prompt over a notice
        notice = None

    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "unknown")
        try:
            contexts.append(core.prepare_drafting_context(cwd, session_id))
        except Exception as exc:  # Drafting cannot safely continue without it.
            sys.stderr.write(f"issues gateway setup failed: {exc}")
            raise SystemExit(2) from exc

    if contexts:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": "\n\n".join(contexts),
                }
            },
            sys.stdout,
        )


if __name__ == "__main__":
    main()
