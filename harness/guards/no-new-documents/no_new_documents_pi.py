"""Native Pi transport; the shared hook owns draft policy and commands."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

import no_new_documents_hook as core


def request(payload: dict) -> dict:
    if payload.get("version") != 1:
        raise ValueError("unsupported Pi document protocol")
    root = Path(payload["cwd"]).resolve()
    operation = payload["operation"]
    if operation == "guard":
        # Parse once, fail closed, and use that same snapshot for the decision.
        patterns = core._configuration(root)
        if os.name == "nt":
            patterns = tuple(re.compile(pattern.pattern, re.IGNORECASE) for pattern in patterns)
        tool = payload["tool"]
        inputs = payload.get("input") or {}
        if tool == "write":
            candidates = [inputs["path"]]
        elif tool in {"bash", "powershell"}:
            candidates = core._shell_candidates(inputs["command"], root)
        else:
            raise ValueError("unsupported document tool")
        target = core.new_document(candidates, root, patterns, strict_paths=True)
        return {"version": 1, "block": target is not None,
                "message": core.draft_guidance(target, root, core.PI) if target is not None else ""}
    if operation == "pending":
        return {"version": 1, "message": core._pending_notice(root) or ""}
    if operation in {"approve", "reject"}:
        message, outcomes = core.draft_command(root, operation, payload.get("argument", ""))
        return {"version": 1, "message": message, "outcomes": outcomes}
    raise ValueError("unknown Pi document operation")


if __name__ == "__main__":
    print(json.dumps(request(json.load(sys.stdin))))
