"""Observe a real parent Stop wait while forwarding all runtime hook events."""
import json
import os
import sys
from pathlib import Path

from subagents_runtime import delegation, hooks

payload = json.load(sys.stdin)
if not os.environ.get("HARNESS_REQUEST_ID") and payload.get("hook_event_name") == "Stop":
    pending = delegation.has_pending_children

    def observe_pending(session_id):
        result = pending(session_id)
        if result:
            receipt = Path(os.environ["HARNESS_E2E_CLI_DIR"]) / "parent-stop-waiting"
            receipt.write_text("waiting", encoding="utf-8")
        return result

    delegation.has_pending_children = observe_pending

output = hooks.handle(payload, provider=sys.argv[1])
if output is not None:
    print(json.dumps(output))
