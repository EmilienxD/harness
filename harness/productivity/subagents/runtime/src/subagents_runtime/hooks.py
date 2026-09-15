"""Provider hook entrypoint for delegation grants, requests, and results."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from subagents_runtime import sessions
from subagents_runtime.delegation import (
    GRANT_POLICIES,
    arm_reply,
    clear_reply_authorization,
    claim_parent_delivery,
    close_parent_grants,
    observe_parent_event,
    open_grant,
    process_grant,
    report_child_stop,
    wait_parent_delivery,
)


SKILL_NAME = r"(ask-agent(?:-to-(?:explore|prototype|websearch|brainstorm|implement|review))?|reply-to-agent)"
INVOCATIONS = {
    "claude": re.compile(rf"(?<!\S)/{SKILL_NAME}(?=\s|$)"),
    "chatgpt": re.compile(rf"(?<!\S)\${SKILL_NAME}(?=\s|$)"),
}
STRUCTURED_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "apply_patch", "ApplyPatch"}

def provider_from_argv(argv: list[str]) -> str | None:
    """The provider the installer wired this hook into, or None if it didn't say."""
    for token in argv:
        if token == "--claude":
            return "claude"
        if token == "--chatgpt":
            return "chatgpt"
    return None


def _context(event: str, text: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def _written_paths(payload: dict[str, Any]) -> list[Path]:
    tool = payload.get("tool_name") or payload.get("tool")
    if tool not in STRUCTURED_WRITE_TOOLS:
        return []
    tool_input = payload.get("tool_input", {})
    paths: set[Path] = set()
    if isinstance(tool_input, dict):
        for key in ("file_path", "path"):
            value = tool_input.get(key)
            if isinstance(value, str):
                paths.add(Path(value).resolve())
    if tool in {"apply_patch", "ApplyPatch"}:
        for text in _strings(tool_input):
            for match in re.finditer(r"^\*\*\* (?:Add|Update) File: (.+)$", text, re.MULTILINE):
                paths.add(Path(match.group(1).strip()).resolve())
    return sorted(paths)


def _grant_for_path(session_id: str, path: Path) -> str | None:
    with sessions._connect() as connection:
        rows = connection.execute(
            "SELECT id, inbox FROM grants WHERE parent_session_id = ? AND state IN ('open', 'used')",
            (session_id,),
        ).fetchall()
    for grant_id, inbox in rows:
        try:
            if path.parent == Path(inbox).resolve():
                return str(grant_id)
        except OSError:
            continue
    return None


def _stop_wait_seconds(cwd: Path) -> float:
    try:
        value = sessions.launch_configuration(cwd)
        session = value.get("session", {}) if isinstance(value, dict) else {}
        hours = session.get("stopWaitHours", 24) if isinstance(session, dict) else 24
        return max(0.0, float(hours) * 3600)
    except (sessions.SessionError, ValueError, TypeError):
        return 24 * 3600


def handle(payload: dict[str, Any], provider: str | None = None) -> dict[str, Any] | None:
    event = str(payload.get("hook_event_name", ""))
    session_id = payload.get("session_id") or os.environ.get("HARNESS_SESSION_ID")
    if not isinstance(session_id, str):
        return None
    cwd = Path(payload.get("cwd") or Path.cwd())
    selected_provider = provider or os.environ.get("HARNESS_PROVIDER", "claude")
    execution_mode = os.environ.get("HARNESS_EXECUTION_MODE", "interactive")
    session_id = sessions.bind_observed(session_id, cwd, selected_provider, execution_mode)

    if event == "SessionStart":
        return None

    if event == "UserPromptSubmit":
        # Codex has no StopFailure event. A new user turn is proof that a
        # previously armed turn did not complete successfully, so expire the
        # one-shot before optionally arming this prompt's reply.
        clear_reply_authorization(session_id)
        delivery = claim_parent_delivery(session_id, event)
        prompt = payload.get("prompt")
        pattern = INVOCATIONS[selected_provider]
        match = pattern.search(prompt) if isinstance(prompt, str) else None
        if match:
            skill = match.group(1)
            if skill == "reply-to-agent":
                arm_reply(session_id)
                context = "Reply armed. The next successful Stop will be sent to the parent."
                return _context(event, context if delivery is None else f"{delivery.text}\n\n{context}")
            grant = open_grant(session_id, skill)
            context = (
                "Delegation inbox opened. Write one Markdown file per child directly under:\n"
                f"{grant.inbox}\n\n"
                "Each file needs YAML frontmatter with task, optional provider, and mode, followed by a nonempty prompt. "
                "Use only a structured Write/Edit/apply_patch tool; shell-created files are ignored."
            )
            return _context(event, context if delivery is None else f"{delivery.text}\n\n{context}")
        if delivery is not None:
            return _context(event, delivery.text)

    if event == "PreToolUse":
        observe_parent_event(session_id, event)
        return None

    if event == "Interrupt":
        clear_reply_authorization(session_id)
        return None

    if event == "PostToolUse":
        processed = []
        for path in _written_paths(payload):
            grant_id = _grant_for_path(session_id, path)
            if grant_id is not None:
                processed.extend(
                    process_grant(grant_id, launch=sessions.launch_delegated, request_paths={path})
                )
        delivery = claim_parent_delivery(session_id, event)
        if delivery is not None:
            return _context(event, delivery.text)
        if processed:
            launched = sum(item.status == "launched" for item in processed)
            failed = sum(item.status == "failed" for item in processed)
            return _context(event, f"Delegation requests processed: {launched} launched, {failed} failed.")
        return None

    if event in {"Stop", "StopFailure", "SessionEnd"}:
        message = payload.get("last_assistant_message")
        if not isinstance(message, str):
            message = ""
        success = event == "Stop" and bool(message.strip())
        report_child_stop(
            session_id,
            message,
            success=success,
            reason=None if success else str(payload.get("reason") or event),
            cancelled=event == "SessionEnd",
        )
        if event == "Stop":
            close_parent_grants(session_id)
            observe_parent_event(session_id, event)
            delivery = wait_parent_delivery(
                session_id,
                timeout_seconds=_stop_wait_seconds(Path(payload.get("cwd") or Path.cwd())),
            )
            if delivery is not None:
                if selected_provider == "chatgpt":
                    return {"decision": "block", "reason": delivery.text}
                return _context(event, delivery.text)
        elif event == "SessionEnd":
            close_parent_grants(session_id, include_open=True)
        return None

    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        provider = provider_from_argv(sys.argv[1:])
        output = handle(payload, provider) if isinstance(payload, dict) else None
        if output is not None:
            print(json.dumps(output))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
