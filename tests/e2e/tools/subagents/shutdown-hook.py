"""Reproduce an automatic CLI that emits SessionEnd without a usable Stop."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from subagents_runtime import hooks
from subagents_runtime.storage import connect

payload = json.load(sys.stdin)
automatic_child = bool(os.environ.get("HARNESS_REQUEST_ID")) and os.environ.get("HARNESS_EXECUTION_MODE") == "auto"
event = payload.get("hook_event_name")
# Exec integrations must recover the native result even when Stop is unavailable.
if not (automatic_child and event == "Stop"):
    output = hooks.handle(payload, provider="chatgpt")
    if output is not None:
        print(json.dumps(output))
if automatic_child and event == "SessionEnd":
    with connect() as connection:
        row = connection.execute(
            "SELECT state,reply IS NOT NULL FROM requests WHERE id=?",
            (os.environ["HARNESS_REQUEST_ID"],),
        ).fetchone()
    receipt = Path(os.environ["HARNESS_E2E_CLI_DIR"]) / f"shutdown-{os.environ['HARNESS_EXECUTION_ID']}.json"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt.with_name(f".{receipt.name}.tmp")
    temporary.write_text(json.dumps({"state": row[0], "hasReply": bool(row[1])}), encoding="utf-8")
    temporary.replace(receipt)
