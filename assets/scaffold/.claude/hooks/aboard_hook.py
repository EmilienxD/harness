import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# Hooks are addressed by an opaque route name, never by a URL path. Claude Code
# runs shell-form hooks through Git Bash on Windows, and MSYS rewrites any bare
# argument that looks like a POSIX path: `/hooks/manager/prompt` arrives as
# `C:/Program Files/Git/hooks/manager/prompt`, no route matches, and every hook
# silently exits 0. The scaffold registers these hooks in exec form so no shell
# is involved, and these names stay path-free so a hand-edited shell-form
# registration cannot resurrect the same failure.
ROUTES = {
    "manager-prompt": "/hooks/manager/prompt",
    "manager-stop": "/hooks/manager/stop",
    "manager-brief-git": "/hooks/manager/brief-git",
    "manager-brief-github": "/hooks/manager/brief-github",
    "manager-brief-fleet": "/hooks/manager/brief-fleet",
    "manager-brief-todo": "/hooks/manager/brief-todo",
    "worker-subagent-start": "/hooks/worker/subagent-start",
    "worker-subagent-stop": "/hooks/worker/subagent-stop",
    "worker-agent-tool": "/hooks/worker/agent-tool",
    "worker-post-compact": "/hooks/worker/post-compact",
    "worker-reground": "/hooks/worker/reground",
    "worker-stop": "/hooks/stop",
    "worker-stop-failure": "/hooks/stop-failure",
}

# The only route whose event (`UserPromptSubmit`) can be blocked. Exit 2 on any
# other route would be read as "refuse to stop" or "refuse to compact".
BLOCKING_ROUTE = "manager-prompt"

# Roles that always run as automated, result-reporting workers. Interactive
# roles (brainstormer, raw, pr-doctor-hitl) never report a result, so worker
# hooks skip them: pr-doctor-hitl waits on the user, and the run's continue
# signal for a hitl issue is the pull request's resolution, not that agent's
# completion. The dual-mode builtin types (general-purpose, Explore) report per
# launch rather than per role: the extension sets ABOARD_DELIVERS_RESULT=1 only
# for result-delivering sessions, so an interactive one stays silent here.
WORKER_AGENT_TYPES = frozenset({"implementer", "pr-doctor-afk"})

# Commands the bridge handles itself. Matches the bridge-side parsers.
INTERCEPTED_COMMAND = re.compile(r"^\s*/(brainstorm|raw|auto|review-pr)(?:\s[\s\S]*)?$")


def finish(message):
    """Erase the prompt and show `message` to the user in place of a response.

    This is the success path as much as the failure path. `/brainstorm` and
    `/raw` are mechanical: the bridge spawns the terminal, and waking the
    Manager to narrate that costs a turn and risks it acting on the command a
    second time. Exit 2 on `UserPromptSubmit` blocks prompt processing and
    erases the prompt, and stderr becomes what the user sees. The Manager is
    told what happened later, batched into the next real prompt.
    """
    sys.stderr.write("\n" + message.strip() + "\n")
    return 2


def intercepted_prompt(prompt):
    return isinstance(prompt, str) and INTERCEPTED_COMMAND.match(prompt) is not None


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--routes":
        json.dump(ROUTES, sys.stdout)
        return 0
    agent_id = os.environ.get("ABOARD_AGENT_ID")
    route = sys.argv[1] if len(sys.argv) >= 2 else None
    endpoint = ROUTES.get(route)
    if not agent_id or endpoint is None:
        return 0
    agent_type = os.environ.get("ABOARD_AGENT_TYPE")
    delivers_result = os.environ.get("ABOARD_DELIVERS_RESULT") == "1"
    expected_manager = route.startswith("manager-")
    if (expected_manager and agent_type != "manager") or (
        not expected_manager and agent_type not in WORKER_AGENT_TYPES and not delivers_result
    ):
        return 0
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(payload, dict):
        payload = {}
    prompt = payload.get("prompt", "")
    blocking = route == BLOCKING_ROUTE
    is_intercepted = blocking and intercepted_prompt(prompt)
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
    if blocking and result.get("intercepted"):
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
