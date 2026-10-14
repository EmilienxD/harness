"""Native Pi transport; the shared hook owns draft policy and commands."""
from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys

import no_new_documents_hook as core


def request(payload: dict) -> dict:
    root = Path(payload["cwd"]).resolve()
    operation = payload["operation"]
    if operation == "guard":
        core.PROVIDER = core.PI
        core._configuration(root)  # A broken installed policy must not silently disable Pi protection.
        tool = payload["tool"]
        inputs = payload.get("input") or {}
        names = {"write": "Write", "bash": "Bash", "powershell": "PowerShell"}
        mapped = {"file_path": inputs.get("path")} if tool == "write" else inputs
        output = StringIO()
        with redirect_stdout(output):
            core.guard_tool({"cwd": str(root), "tool_name": names.get(tool), "tool_input": mapped})
        result = json.loads(output.getvalue()) if output.getvalue() else {}
        reason = result.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        return {"version": 1, "block": bool(reason), "message": reason}
    if operation == "pending":
        return {"version": 1, "message": core._pending_notice(root) or ""}
    if operation in {"approve", "reject"}:
        message, outcomes = core.draft_command(root, operation, payload.get("argument", ""))
        return {"version": 1, "message": message, "outcomes": outcomes}
    raise ValueError("unknown Pi document operation")


if __name__ == "__main__":
    print(json.dumps(request(json.load(sys.stdin))))
