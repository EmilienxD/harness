from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
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
    "prompt-submit": "/hooks/prompt-submit",
    "session-end": "/hooks/session-end",
}

RESULT_REPORTING_TYPES: frozenset[str] = frozenset({"explore", "address", "review"})
ADDRESS_COMMIT_REMINDER = (
    'You have modified files without committing them. Is there a real reason for this? '
    'Did you discover any blockers along the way? If so, immediatly answer '
    '"Yes, there is blockers, as described above". Otherwise if the task is complete: Commit the changes.'
)
REVIEW_COMMIT_REMINDER = (
    "You have not modified any files or created a review commit. If the review is complete and approved, "
    "create an empty commit; otherwise report the blockers and leave the repository unchanged."
)


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


def executable_name(word: str) -> str:
    name = word.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name[:-4] if name.endswith(".exe") else name


def command_candidates(segment: str) -> list[str]:
    normalized = " ".join(segment.split())
    try:
        words = shlex.split(segment, posix=True)
    except ValueError:
        return [normalized]
    candidates = [normalized]
    while words and executable_name(words[0]) in {"env", "command"}:
        wrapper = executable_name(words[0])
        words = words[1:]
        while words:
            word = words[0]
            if word == "--":
                words = words[1:]
                break
            if wrapper == "env" and word in {"-u", "--unset", "-C", "--chdir"}:
                words = words[2:] if len(words) >= 2 else []
                continue
            if word.startswith("-"):
                words = words[1:]
                continue
            if wrapper == "env" and word.split("=", 1)[0].isidentifier() and "=" in word:
                words = words[1:]
                continue
            break
    unwrapped = " ".join(words)
    if unwrapped and unwrapped not in candidates:
        candidates.append(unwrapped)
    if words and executable_name(words[0]) in {"sh", "bash", "dash", "ksh", "zsh"}:
        for index, word in enumerate(words[1:], start=1):
            if word.startswith("-") and "c" in word[1:] and index + 1 < len(words):
                candidates.extend(command_candidates(words[index + 1]))
                break
    return candidates


def guard(payload: dict[str, Any]) -> int:
    path = os.environ.get("ABOARD_GUARD_PATH")
    if not path:
        return 0
    if payload.get("hook_event_name") != "PreToolUse":
        return 0
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
        candidates = command_candidates(segment)
        for pattern in patterns:
            if any(matches(pattern, candidate) for candidate in candidates):
                return deny(
                    f"aboard owns this run's git and GitHub state; {' '.join(segment.split())} is blocked. "
                    "Use git and gh only for allowed inspection, staging, and commit operations. Follow the completion contract injected for this turn."
                )
    return 0


def stop_reminder(payload: dict[str, Any]) -> str | None:
    starting_sha = os.environ.get("ABOARD_WORKER_START_SHA")
    if payload.get("stop_hook_active") is True or not starting_sha:
        return None
    role = os.environ.get("ABOARD_AGENT_TYPE")
    if role not in {"address", "review"}:
        return None
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        return None
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=cwd,
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if status.returncode != 0:
        return None
    if role == "address":
        return ADDRESS_COMMIT_REMINDER if status.stdout else None
    if status.stdout:
        return None
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=cwd,
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return REVIEW_COMMIT_REMINDER if head.returncode == 0 and head.stdout.strip() == starting_sha else None


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
    if endpoint == "/hooks/stop" and event == "Stop":
        reminder = stop_reminder(payload)
        if reminder is not None:
            print(json.dumps({"decision": "block", "reason": reminder}))
            return 0
    # Runtime-assigned platforms report the canonical conversation id here;
    # client-assigned platforms report the same id Aboard placed in the env.
    session_id = payload.get("session_id") or os.environ.get("ABOARD_SESSION_ID")

    body: dict[str, Any]
    if endpoint == "/hooks/session-start":
        if event != "SessionStart":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id, "source": payload.get("source")}
    elif endpoint == "/hooks/prompt-submit":
        # Every agent type reports this: it confirms that a prompt Aboard typed
        # reached the provider, and one nobody is waiting on is ignored.
        if event != "UserPromptSubmit":
            return 0
        body = {"agentId": agent_id, "sessionId": session_id}
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
