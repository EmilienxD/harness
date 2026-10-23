#!/usr/bin/env python3
"""Inject cleanup facts only on explicit skill invocation."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

from cleanup_git import FactError, prepared_inventory, render_inventory


def handle(payload: dict) -> dict | None:
    if payload.get("hook_event_name", "UserPromptSubmit") != "UserPromptSubmit":
        return None
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        return None
    match = re.fullmatch(r"\s*[/$]cleanup-git(?:\s+(.*))?\s*", prompt, re.DOTALL)
    if not match:
        return None
    cwd = Path(payload.get("cwd") or Path.cwd())
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                   "additionalContext": prepared_inventory(cwd)}}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = handle(payload) if isinstance(payload, dict) else None
        if result:
            print(json.dumps(result, ensure_ascii=True))
    except (ValueError, OSError, FactError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
              "additionalContext": render_inventory({"error": str(error),
                  "next_step": "Gather missing facts with read-only Git commands before proposing cleanup."})}}))


if __name__ == "__main__":
    main()
