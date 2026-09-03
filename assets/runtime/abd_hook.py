from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any
import urllib.error
import urllib.request

# Hooks are addressed by an opaque route name, never by a URL path. Claude Code
# runs shell-form hooks through Git Bash on Windows, and MSYS rewrites any bare
# argument that looks like a POSIX path: `/hooks/manager/prompt` arrives as
# `C:/Program Files/Git/hooks/manager/prompt`, no route matches, and every hook
# silently exits 0. The scaffold registers these hooks in exec form so no shell
# is involved, and these names stay path-free so a hand-edited shell-form
# registration cannot resurrect the same failure.
ROUTES: dict[str, str] = {
    "manager-prompt": "/hooks/manager/prompt",
    "report-stop": "/hooks/reports/stop",
    "report-delivery": "/hooks/reports/deliver",
    "manager-brief": "/hooks/manager/brief",
    "manager-roadmap": "/hooks/manager/roadmap",
    "worker-subagent-start": "/hooks/worker/subagent-start",
    "worker-subagent-stop": "/hooks/worker/subagent-stop",
    "worker-agent-tool": "/hooks/worker/agent-tool",
    "worker-post-compact": "/hooks/worker/post-compact",
    "worker-reground": "/hooks/worker/reground",
    "worker-stop": "/hooks/stop",
    "worker-stop-failure": "/hooks/stop-failure",
    "session-start": "/hooks/session-start",
    "session-end": "/hooks/session-end",
}

# The only route whose event (`UserPromptSubmit`) can be blocked. Exit 2 on any
# other route would be read as "refuse to stop" or "refuse to compact".
BLOCKING_ROUTE: str = "manager-prompt"

# Roles whose non-completion worker telemetry hooks apply. Whether Stop itself
# completes a session is a separate launch fact: ABOARD_ATTENDED marks sessions
# the user drives, which report only through /done.
WORKER_AGENT_TYPES: frozenset[str] = frozenset({"webresearcher", "implementer", "pr-doctor-afk", "Explore"})

# Commands the bridge handles itself. `/done` is available in every aboard
# terminal; the remaining commands belong only to the Manager. `/queue` also
# requires a Manager because its admission and sequencing live there. These expressions
# match the bridge-side parsers.
MANAGER_INTERCEPTED_COMMAND: re.Pattern[str] = re.compile(r"^\s*/(brainstorm|general-purpose|queue|prototype|done|auto|review-pr|reopen)(?:\s[\s\S]*)?$")
SESSION_INTERCEPTED_COMMAND: re.Pattern[str] = re.compile(r"^\s*/(done|prototype)(?:\s[\s\S]*)?$")

# Leads every roadmap injection the bridge emits, on the session-start briefing
# and on the periodic reminder alike. Plain ASCII with no quotes, backslashes, or
# newlines, so it matches identically inside the JSON-escaped `stdout` string and
# the unescaped `content` array that the transcript records for a hook.
ROADMAP_MARKER: bytes = b"<aboard-roadmap>"

# How many transcript bytes may pass with no roadmap injection before one is due.
# Set from `aboard.manager.roadmapReminderBytes` into the Manager's terminal
# alone; absent or zero disables the reminder entirely.
ROADMAP_SPAN_VARIABLE: str = "ABOARD_ROADMAP_REMINDER_BYTES"


def roadmap_reminder_due(payload: dict[str, Any]) -> bool:
    """Is there no roadmap injection within the transcript's last `span` bytes?

    Stateless by construction. The question is not "where was the last
    reminder", which would need a counter to persist, re-seed on resume, and
    lose in a crash, but "is one inside the tail window"; one `getsize`, one
    bounded read, constant work whether the transcript is 200 KB or 40 MB. The
    session-start and post-compact briefings carry the same marker, so they
    reset the window for free and there is no separate reset rule.

    Every uncertain answer is "not due": a reminder is a convenience, and
    injecting one on a transcript we could not read would be guessing.
    """
    try:
        span = int(os.environ.get(ROADMAP_SPAN_VARIABLE) or 0)
    except ValueError:
        return False
    path = payload.get("transcript_path")
    if span <= 0 or not isinstance(path, str) or not path:
        return False
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as transcript:
            if size > span:
                transcript.seek(size - span)
            tail = transcript.read()
    except OSError:
        return False
    return ROADMAP_MARKER not in tail


def mailbox_has_entries(agent_id: str) -> bool:
    """Cheap common-path check before a PostToolUse/prompt bridge round trip."""
    runtime_root = os.environ.get("ABOARD_RUNTIME_ROOT")
    if not runtime_root:
        return False
    try:
        with open(os.path.join(runtime_root, "state", "fleet.json"), encoding="utf-8") as source:
            fleet = json.load(source)
    except (OSError, ValueError):
        return False
    mailboxes = fleet.get("mailboxes") if isinstance(fleet, dict) else None
    if not isinstance(mailboxes, list):
        return False
    return any(
        isinstance(mailbox, dict)
        and (mailbox.get("recipientAgentId") or mailbox.get("managerAgentId")) == agent_id
        and isinstance(mailbox.get("entries"), list)
        and bool(mailbox["entries"])
        for mailbox in mailboxes
    )


def finish(message: str) -> int:
    """Erase the prompt and show `message` to the user in place of a response.

    This is the success path as much as the failure path. `/brainstorm` and
    `/general-purpose` are mechanical: the bridge spawns the terminal, and waking the
    Manager to narrate that costs a turn and risks it acting on the command a
    second time. Exit 2 on `UserPromptSubmit` blocks prompt processing and
    erases the prompt, and stderr becomes what the user sees. The Manager is
    told what happened later, batched into the next real prompt.
    """
    sys.stderr.write("\n\n" + message.strip())
    return 2


def intercepted_prompt(prompt: Any, agent_type: str | None) -> bool:
    if not isinstance(prompt, str):
        return False
    command = MANAGER_INTERCEPTED_COMMAND if agent_type == "manager" else SESSION_INTERCEPTED_COMMAND
    return command.match(prompt) is not None


def main() -> int:
    # Claude Code writes hook JSON as UTF-8. Python otherwise opens redirected
    # standard streams with the active ANSI code page on Windows, silently
    # turning characters such as an em dash into mojibake before they reach the
    # bridge. Hook output uses the same wire encoding in the opposite direction.
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
    agent_type = os.environ.get("ABOARD_AGENT_TYPE")
    attended = os.environ.get("ABOARD_ATTENDED") == "1"
    expected_manager = route.startswith("manager-") if route else False
    try:
        payload_raw: Any = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    payload: dict[str, Any] = payload_raw if isinstance(payload_raw, dict) else {}
    prompt = payload.get("prompt", "")
    # The shared UserPromptSubmit registration reaches every aboard terminal.
    # Only `/done` is meaningful outside the Manager; skip the bridge entirely
    # for all other prompts so worker input remains untouched.
    if route == BLOCKING_ROUTE and agent_type != "manager" and not intercepted_prompt(prompt, agent_type) and not mailbox_has_entries(agent_id):
        return 0
    if route == "report-delivery" and not mailbox_has_entries(agent_id):
        return 0
    # Lifecycle routes are role-agnostic: every aboard session reports its TUI
    # pid and its end, so the write-lease recovery and startup proof-of-life
    # cover Managers, interactive types, and workers alike. Only `ABOARD_AGENT_ID`
    # gates them (checked above), never the agent type.
    # webresearcher and Explore report completion but have no implementation branch or issue
    # contract to re-ground, and neither spawns code-exploration subagents.
    if agent_type in ("webresearcher", "Explore") and route not in ("worker-stop", "worker-stop-failure", "report-stop", "report-delivery", "session-start", "session-end"):
        return 0
    if route not in ("session-start", "session-end") and (
        (expected_manager and route != BLOCKING_ROUTE and agent_type != "manager") or (
            route in ("worker-stop", "worker-stop-failure") and attended
        ) or (
            route.startswith("worker-") and route not in ("worker-stop", "worker-stop-failure") and agent_type not in WORKER_AGENT_TYPES
        )
    ):
        return 0
    # The reminder's entire cost on the common path; a reminder already inside
    # the tail window; is one `getsize` and one bounded read. No bridge call, no
    # `gh`, no output.
    if route == "manager-roadmap" and not roadmap_reminder_due(payload):
        return 0
    blocking = route == BLOCKING_ROUTE
    is_intercepted = blocking and intercepted_prompt(prompt, agent_type)
    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
    except (KeyError, ValueError):
        return finish("Aboard could not handle that command because its bridge credentials or runtime are unavailable.") if is_intercepted else 0
    event = payload.get("hook_event_name")
    session_id = os.environ.get("ABOARD_SESSION_ID") or payload.get("session_id")
    body: dict[str, Any]
    if endpoint == "/hooks/session-start":
        # Proof-of-life only: the liveness signal itself is the wrapper's lock
        # file owned by aboard's launch wrapper for the child's exact lifetime.
        # No pid, no process-table scraping.
        if event != "SessionStart":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id, "source": payload.get("source")}
    elif endpoint == "/hooks/session-end":
        if event != "SessionEnd":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id, "reason": payload.get("reason") or "other"}
    elif endpoint.startswith("/hooks/worker/"):
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
    elif endpoint == "/hooks/stop":
        # A worker reporting its own completion. `last_assistant_message` is
        # required by the bridge and is the documented way to read the final
        # message; transcript_path may still lag at Stop time.
        last_assistant_message = payload.get("last_assistant_message")
        if not isinstance(last_assistant_message, str) or not last_assistant_message.strip():
            return 0
        body = {
            "agentId": agent_id,
            "sessionId": session_id,
            "cwd": payload.get("cwd"),
            "lastAssistantMessage": last_assistant_message,
        }
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
            # A due reminder rides along with the prompt instead of costing its
            # own spawn and round trip. An intercepted command erases the turn,
            # so there is nothing to attach a reminder to.
            if not is_intercepted and roadmap_reminder_due(payload):
                body["roadmapDue"] = True
        if endpoint == "/hooks/reports/stop":
            body["stopHookActive"] = bool(payload.get("stop_hook_active", False))
            body["lastAssistantMessage"] = payload.get("last_assistant_message")
    filtered_body = {key: value for key, value in body.items() if value is not None}
    result_raw: Any = None
    while True:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{endpoint}",
            data=json.dumps(filtered_body).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=86_400) as response:
                result_raw = json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, ConnectionError, TimeoutError, ValueError) as error:
            if is_intercepted:
                return finish(f"Aboard did not launch the requested session: {error}.")
            return 0
        if not isinstance(result_raw, dict) or result_raw.get("state") != "running":
            break
        time.sleep(1)
    if not isinstance(result_raw, dict):
        return 0
    result: dict[str, Any] = result_raw
    if blocking and result.get("intercepted"):
        return finish(str(result.get("message", "Aboard handled the command.")))
    # Only events that support context injection may print. Stop and
    # UserPromptSubmit do; the worker result routes deliberately do not.
    if endpoint == "/hooks/reports/stop":
        if result.get("state") == "results":
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": result.get("additionalContext")}}))
    elif "additionalContext" in result and event in ("SessionStart", "UserPromptSubmit", "PostToolUse"):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": result["additionalContext"]}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
