#!/usr/bin/env python3
"""Inject cleanup facts only on explicit skill invocation."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

from cleanup_git import FactError, collect, render_inventory


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
    facts = collect(cwd)
    # Preserve every branch/worktree; keep per-item previews small.
    for checkout in facts["worktrees"]:
        for key in ("changes", "ignored"):
            checkout[f"{key}_omitted"] = max(0, checkout[f"{key}_count"] - 5)
            del checkout[key][5:]
    facts["inventory_command"] = [sys.executable, str(Path(__file__).with_name("cleanup_git.py"))]
    facts["inventory_cwd"] = str(cwd.resolve())
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                   "additionalContext": render_inventory(facts)}}


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
