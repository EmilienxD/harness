import json
import os
import sys
import time
import urllib.error
import urllib.request

# Endpoints served by the Manager hook routes. Everything else is a worker
# route. Membership is explicit because several endpoints share a suffix
# (`/hooks/manager/stop` and `/hooks/stop` both end in "/stop").
MANAGER_ENDPOINTS = frozenset({
    "/hooks/manager/prompt",
    "/hooks/manager/stop",
    "/hooks/manager/brief-git",
    "/hooks/manager/brief-github",
    "/hooks/manager/brief-fleet",
    "/hooks/manager/brief-todo",
})

# Roles that run as automated, result-reporting workers. Interactive roles
# (brainstormer, raw) never report a result, so worker hooks skip them.
WORKER_AGENT_TYPES = frozenset({"implementer", "reviewer", "fixer"})


def finish(message):
    sys.stderr.write("\n" + message.strip() + "\n")
    return 2


def intercepted_prompt(prompt):
    stripped = prompt.strip()
    return stripped == "/raw" or stripped.startswith("/raw ") or stripped == "/brainstorm" or stripped.startswith("/brainstorm ")


def main():
    agent_id = os.environ.get("ABOARD_AGENT_ID")
    if not agent_id or len(sys.argv) < 2:
        return 0
    endpoint = sys.argv[1]
    agent_type = os.environ.get("ABOARD_AGENT_TYPE")
    expected_manager = endpoint in MANAGER_ENDPOINTS
    if (expected_manager and agent_type != "manager") or (not expected_manager and agent_type not in WORKER_AGENT_TYPES):
        return 0
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(payload, dict):
        payload = {}
    prompt = payload.get("prompt", "")
    is_intercepted = endpoint == "/hooks/manager/prompt" and isinstance(prompt, str) and intercepted_prompt(prompt)
    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
    except (KeyError, ValueError):
        return finish("Aboard could not handle that command because bridge discovery is unavailable.") if is_intercepted else 0
    event = payload.get("hook_event_name")
    session_id = os.environ.get("ABOARD_SESSION_ID") or payload.get("session_id")
    if endpoint.startswith("/hooks/worker/"):
        body = {"parentAgentId": agent_id}
        if endpoint.endswith("/subagent-start") or endpoint.endswith("/subagent-stop"):
            body.update({"childAgentId": payload.get("agent_id"), "agentType": payload.get("agent_type")})
        if endpoint.endswith("/subagent-stop"):
            body["result"] = payload.get("last_assistant_message")
        if endpoint.endswith("/agent-tool"):
            if payload.get("tool_name") != "Agent":
                return 0
            body["toolResponse"] = payload.get("tool_response")
        if endpoint.endswith("/post-compact"):
            body["compactSummary"] = payload.get("compact_summary")
        if endpoint.endswith("/reground"):
            if not (event == "SessionStart" and payload.get("source") == "compact"):
                return 0
            body["cwd"] = payload.get("cwd")
    elif endpoint == "/hooks/stop":
        # A worker reporting its own completion. `last_assistant_message` is
        # required by the bridge and is the documented way to read the final
        # message; transcript_path may still lag at Stop time.
        body = {
            "agentId": agent_id,
            "sessionId": session_id,
            "cwd": payload.get("cwd"),
            "lastAssistantMessage": payload.get("last_assistant_message"),
        }
        if not isinstance(body["lastAssistantMessage"], str) or not body["lastAssistantMessage"].strip():
            return 0
    elif endpoint == "/hooks/stop-failure":
        body = {
            "agentId": agent_id,
            "sessionId": session_id,
            "error": payload.get("error") or "unknown",
            "errorDetails": payload.get("error_details"),
            "lastAssistantMessage": payload.get("last_assistant_message"),
        }
    else:
        body = {"agentId": agent_id}
        if endpoint == "/hooks/manager/prompt":
            body["prompt"] = prompt
        if endpoint == "/hooks/manager/stop":
            body["stopHookActive"] = bool(payload.get("stop_hook_active", False))
    body = {key: value for key, value in body.items() if value is not None}
    while True:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{endpoint}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, ConnectionError, TimeoutError, ValueError) as error:
            if is_intercepted:
                return finish(f"Aboard did not launch the requested session: {error}.")
            return 0
        if not isinstance(result, dict) or result.get("state") != "running":
            break
        time.sleep(1)
    if not isinstance(result, dict):
        return 0
    if result.get("intercepted"):
        return finish(str(result.get("message", "Aboard handled the command.")))
    # Only events that support context injection may print. Stop and
    # UserPromptSubmit do; the worker result routes deliberately do not.
    if endpoint == "/hooks/manager/stop":
        if result.get("state") == "results":
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": result["additionalContext"]}}))
    elif "additionalContext" in result and event in ("SessionStart", "UserPromptSubmit"):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": result["additionalContext"]}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
