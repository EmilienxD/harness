"""Pi command-guard evaluation reusing the shipped Python policy core."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import command_guard_hook as core


def evaluate(request: dict) -> dict:
    if request.get("version") != 1:
        raise ValueError("Unsupported protocol")
    command = request.get("command")
    response = {"version": 1, "block": False, "message": ""}
    if not isinstance(command, str) or not command:
        return response
    root = Path(request["cwd"])
    reason = core.denial_reason(command, root)
    if reason:
        response["block"] = True
        response["message"] = reason
    return response


if __name__ == "__main__":
    try:
        print(json.dumps(evaluate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        print("Pi command-guard operation failed", file=sys.stderr)
        sys.exit(1)
