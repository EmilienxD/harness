from __future__ import annotations

import json
import os
import re
import sys
from typing import Any
import urllib.error
import urllib.request

# Enforced locally: a worker restriction must not depend on a bridge round trip.
GUARD_ROUTE = "worker-guard"
SUBAGENT_TOOLS: frozenset[str] = frozenset({"Agent", "spawn_agent"})
UNREADABLE = "aboard cannot read the restriction list for this worker, so the call is blocked."

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


def deny(reason: str) -> int:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    return 0


def command_text(tool_input: Any) -> str:
    if not isinstance(tool_input, dict):
        return ""
    command = tool_input.get("command")
    if isinstance(command, list):
        return " ".join(str(part) for part in command)
    return command if isinstance(command, str) else ""


def matches(pattern: str, segment: str) -> bool:
    expression = "".join(".*" if part == "*" else re.escape(part) for part in re.split(r"(\*)", pattern))
    return re.fullmatch(expression, " ".join(segment.split())) is not None


def guard(payload: dict[str, Any]) -> int:
    if payload.get("hook_event_name") != "PreToolUse":
        return 0
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "guard.json")
    try:
        with open(path, encoding="utf-8") as handle:
            rules: Any = json.load(handle)
    except (OSError, ValueError):
        return deny(UNREADABLE)
    if not isinstance(rules, dict):
        return deny(UNREADABLE)
    if rules.get("denySubagents") and payload.get("tool_name") in SUBAGENT_TOOLS:
        return deny("aboard's auto-run workers cannot spawn subagents. Do the work in this session.")
    command = command_text(payload.get("tool_input"))
    if not command.strip():
        return 0
    patterns = [pattern for pattern in rules.get("denyCommands", []) if isinstance(pattern, str)]
    for segment in re.split(r"&&|\|\||[;\n|]", command):
        if not segment.strip():
            continue
        for pattern in patterns:
            if matches(pattern, segment):
                return deny(
                    f"aboard owns this run's git and GitHub state; {' '.join(segment.split())} is blocked. "
                    "Leave your work uncommitted in the working tree and use git and gh only for read-only inspection."
                )
    return 0


def main() -> int:
    # Agent hook wire formats are UTF-8 regardless of the ambient Windows code
    # page.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) >= 2 and sys.argv[1] == "--routes":
        json.dump(ROUTES, sys.stdout)
        return 0

    route: str | None = sys.argv[1] if len(sys.argv) >= 2 else None
    try:
        payload_raw: Any = json.load(sys.stdin)
    except (ValueError, OSError):
        payload_raw = None
    payload: dict[str, Any] = payload_raw if isinstance(payload_raw, dict) else {}

    if route == GUARD_ROUTE:
        # Reporting routes may drop an event they cannot read; a restriction
        # that cannot read its own event has to block instead.
        return guard(payload) if isinstance(payload_raw, dict) else deny(UNREADABLE)
    if not isinstance(payload_raw, dict):
        return 0

    agent_id = os.environ.get("ABOARD_AGENT_ID")
    endpoint = ROUTES.get(route) if route else None
    if not agent_id or endpoint is None:
        return 0

    event = payload.get("hook_event_name")
    # Runtime-assigned platforms report the canonical conversation id here;
    # client-assigned platforms report the same id Aboard placed in the env.
    session_id = payload.get("session_id") or os.environ.get("ABOARD_SESSION_ID")

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
        if endpoint != "/hooks/stop" and os.environ.get("ABOARD_AGENT_TYPE") not in RESULT_REPORTING_TYPES:
            return 0
        if endpoint == "/hooks/worker/post-compact":
            if event != "PostCompact":
                return 0
            body = {"agentId": agent_id, "sessionId": session_id, "compactSummary": payload.get("compact_summary")}
        elif endpoint == "/hooks/worker/reground":
            if event != "SessionStart" or payload.get("source") != "compact":
                return 0
            body = {"agentId": agent_id}
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
