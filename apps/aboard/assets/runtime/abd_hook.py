from __future__ import annotations

import json
import os
import sys
from typing import Any
import urllib.error
import urllib.request

# Opaque, path-free names avoid MSYS rewriting hook arguments on Windows.
ROUTES: dict[str, str] = {
    "worker-post-compact": "/hooks/worker/post-compact",
    "worker-reground": "/hooks/worker/reground",
    "worker-stop": "/hooks/stop",
    "worker-stop-failure": "/hooks/stop-failure",
    "session-start": "/hooks/session-start",
    "session-end": "/hooks/session-end",
}

RESULT_REPORTING_TYPES: frozenset[str] = frozenset({"Explore", "implementer", "reviewer"})


def main() -> int:
    # Claude Code's hook wire format is UTF-8 regardless of the ambient Windows
    # code page.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) >= 2 and sys.argv[1] == "--routes":
        json.dump(ROUTES, sys.stdout)
        return 0

    agent_id = os.environ.get("ABOARD_AGENT_ID")
    route: str | None = sys.argv[1] if len(sys.argv) >= 2 else None
    endpoint = ROUTES.get(route) if route else None
    if not agent_id or endpoint is None:
        return 0

    try:
        payload_raw: Any = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    payload: dict[str, Any] = payload_raw if isinstance(payload_raw, dict) else {}
    event = payload.get("hook_event_name")
    session_id = os.environ.get("ABOARD_SESSION_ID") or payload.get("session_id")

    body: dict[str, Any]
    if endpoint == "/hooks/session-start":
        if event != "SessionStart":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id, "source": payload.get("source")}
    elif endpoint == "/hooks/session-end":
        if event != "SessionEnd":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id, "reason": payload.get("reason") or "other"}
    else:
        if os.environ.get("ABOARD_AGENT_TYPE") not in RESULT_REPORTING_TYPES:
            return 0
        if endpoint == "/hooks/worker/post-compact":
            if event != "PostCompact":
                return 0
            body = {"parentAgentId": agent_id, "compactSummary": payload.get("compact_summary")}
        elif endpoint == "/hooks/worker/reground":
            if event != "SessionStart" or payload.get("source") != "compact":
                return 0
            body = {"parentAgentId": agent_id}
        elif endpoint == "/hooks/stop":
            last_assistant_message = payload.get("last_assistant_message")
            if event != "Stop" or not isinstance(last_assistant_message, str) or not last_assistant_message.strip():
                return 0
            body = {
                "agentId": agent_id,
                "sessionId": session_id,
                "cwd": payload.get("cwd"),
                "lastAssistantMessage": last_assistant_message,
            }
        else:
            if event != "StopFailure":
                return 0
            body = {
                "agentId": agent_id,
                "sessionId": session_id,
                "error": payload.get("error") or "unknown",
                "errorDetails": payload.get("error_details"),
                "lastAssistantMessage": payload.get("last_assistant_message"),
            }

    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
    except (KeyError, ValueError):
        return 0

    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{endpoint}",
        data=json.dumps({key: value for key, value in body.items() if value is not None}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result_raw: Any = json.load(response)
    except (urllib.error.HTTPError, urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
        return 0

    if (
        endpoint == "/hooks/worker/reground"
        and isinstance(result_raw, dict)
        and "additionalContext" in result_raw
    ):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": result_raw["additionalContext"],
            }
        }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
