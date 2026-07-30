import json
import os
import sys
import time
import urllib.error
import urllib.request


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
    expected_manager = endpoint.startswith("/hooks/manager/")
    if (expected_manager and agent_type != "manager") or (not expected_manager and agent_type not in ("implementer", "reviewer", "fixer")):
        return 0
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    prompt = payload.get("prompt", "") if isinstance(payload, dict) else ""
    is_intercepted = endpoint.endswith("/prompt") and isinstance(prompt, str) and intercepted_prompt(prompt)
    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
    except (KeyError, ValueError):
        return finish("Aboard could not handle that command because bridge discovery is unavailable.") if is_intercepted else 0
    body = {"agentId": agent_id}
    if endpoint.startswith("/hooks/worker/"):
        body = {"parentAgentId": agent_id}
        event = payload.get("hook_event_name")
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
            compact_source = (event == "SessionStart" and payload.get("source") == "compact") or (event == "InstructionsLoaded" and payload.get("load_reason") == "compact")
            if not compact_source:
                return 0
            body["cwd"] = payload.get("cwd")
    if endpoint.endswith("/prompt"):
        body["prompt"] = prompt
    if endpoint.endswith("/stop"):
        body["stopHookActive"] = bool(payload.get("stop_hook_active", False))
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
        if result.get("state") != "running":
            break
        time.sleep(1)
    if result.get("intercepted"):
        return finish(str(result.get("message", "Aboard handled the command.")))
    if "additionalContext" in result:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": payload["hook_event_name"], "additionalContext": result["additionalContext"]}}))
    elif result.get("state") == "results":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": result["additionalContext"]}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
