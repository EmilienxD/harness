"""Versioned operations for the native Pi extension over the shared delegation runtime.

Pi passes lifecycle events (native session ID, tool completion, final messages) instead of
emulating Claude/Codex hook payloads. Every response is one JSON object on stdout.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from subagents_runtime import sessions
from subagents_runtime.delegation import (
    acknowledge_parent_delivery,
    arm_reply,
    claim_parent_delivery,
    clear_reply_authorization,
    has_pending_children,
    scan_inbox,
    report_child_stop,
    results_marker,
    send_previous_reply,
)
from subagents_runtime.hooks import (
    PREVIOUS_REPLY_SKILL,
    SKILL_NAME,
    _parent_terminal_message,
    _processing_context,
    _registered_skill,
    _role_directory,
    _stop_wait_seconds,
)
from subagents_runtime.messages import runtime_message

PROTOCOL = 1
INVOCATION = re.compile(rf"(?<!\S)/skill:{SKILL_NAME}(?=\s|$)")


class BridgeError(ValueError):
    pass


def _session(request: dict[str, Any]) -> tuple[str, str | None, str | None]:
    """The bound Harness session, its parent, and its delegated execution mode."""
    session_id = request.get("harnessSessionId")
    if not isinstance(session_id, str) or not session_id:
        raise BridgeError("harnessSessionId is required")
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT parent_session_id,execution_mode FROM sessions WHERE id=? AND provider='pi'",
            (session_id,),
        ).fetchone()
    if row is None:
        raise BridgeError("the Pi session is not registered")
    return session_id, row[0], row[1]


def _execution_id(session_id: str) -> str | None:
    """Only the delegated conversation itself speaks for its launch execution."""
    if session_id != os.environ.get("HARNESS_SESSION_ID"):
        return None
    return os.environ.get("HARNESS_EXECUTION_ID")


def session_start(request: dict[str, Any]) -> dict[str, Any]:
    native = request.get("sessionId")
    if not isinstance(native, str) or not native:
        raise BridgeError("sessionId is required")
    cwd = Path(request.get("cwd") or Path.cwd())
    reason = request.get("reason")
    if reason in {"new", "fork"}:
        # In-process /new and /fork start conversations of the user's own.
        sessions.register_observed(native, cwd, "pi")
        session_id = native
    else:
        session_id = sessions.bind_observed(
            native, cwd, "pi", os.environ.get("HARNESS_EXECUTION_MODE", "interactive")
        )
    from subagents_runtime.inbox_cleanup import observe_activity
    from subagents_runtime.processes import confirm_startup, live_executions

    observe_activity(session_id)
    execution_id = _execution_id(session_id)
    if execution_id and reason in {"startup", "reload"}:
        from subagents_runtime.reply_support import acknowledge

        acknowledge(cwd, "pi")
        confirm_startup(execution_id)
    with sessions._connect() as connection:
        enabled = connection.execute(
            "SELECT 1 FROM session_delegation WHERE parent_session_id=?", (session_id,)
        ).fetchone()
    recovered = []
    if enabled:
        recovered = scan_inbox(session_id)
        with sessions._connect() as connection:
            children = connection.execute(
                "SELECT DISTINCT child_session_id FROM requests WHERE parent_session_id=? AND child_session_id IS NOT NULL AND state IN ('launching','pending','uncertain')",
                (session_id,),
            ).fetchall()
        for (child_id,) in children:
            live_executions(child_id)
    _, _parent, mode = _session({"harnessSessionId": session_id})
    return {
        "harnessSessionId": session_id,
        "delegatedMode": mode if _parent else None,
        "recovered": _processing_context(recovered) if recovered else None,
        "marker": str(results_marker(session_id)),
        "pending": has_pending_children(session_id),
        "stopWaitSeconds": _stop_wait_seconds(cwd),
    }


def prompt(request: dict[str, Any]) -> dict[str, Any]:
    session_id, parent, mode = _session(request)
    text = request.get("text")
    if not isinstance(text, str):
        raise BridgeError("text is required")
    if parent and mode == "interactive":
        # A new user turn proves an armed turn did not complete; expire it first.
        clear_reply_authorization(session_id)
    cwd = _role_directory(session_id)
    skill = next(
        (match.group(1) for match in INVOCATION.finditer(text)
         if match.group(1) not in {"ship", PREVIOUS_REPLY_SKILL}
         and _registered_skill(match.group(1), cwd, "pi")),
        None,
    )
    if skill is None:
        return {"context": None, "notice": None}
    if skill == "reply-to-agent":
        arm_reply(session_id, _execution_id(session_id))
        return {"context": None, "notice": "Reply armed. The next successful response will be sent to the parent."}
    return {"context": None, "notice": None}


def previous_reply(request: dict[str, Any]) -> dict[str, Any]:
    session_id, _parent, _mode = _session(request)
    message = request.get("message")
    if not isinstance(message, str):
        raise BridgeError("message is required")
    send_previous_reply(session_id, message, _execution_id(session_id))
    notice = "Previous assistant message sent to the parent."
    if link := _parent_terminal_message():
        notice += f"\n{link}"
    return {"notice": notice}


def inbox_scan(request: dict[str, Any]) -> dict[str, Any]:
    session_id, _parent, _mode = _session(request)
    processed = scan_inbox(session_id)
    return {
        "context": _processing_context(processed) if processed else None,
        "changed": any(item.status in {"launched", "failed"} for item in processed),
        "pending": has_pending_children(session_id),
    }


def settled(request: dict[str, Any]) -> dict[str, Any]:
    session_id, parent, mode = _session(request)
    if not parent or mode != "interactive":
        # Headless children report through their supervisor's JSON stream.
        return {"reported": False, "notice": None}
    success = request.get("success") is True
    message = request.get("message") if isinstance(request.get("message"), str) else ""
    success = success and bool(message.strip())
    reason = request.get("reason") if isinstance(request.get("reason"), str) else "Pi turn failed"
    reported = report_child_stop(
        session_id, message, success=success, reason=None if success else reason,
        execution_id=_execution_id(session_id),
    )
    return {"reported": reported, "notice": _parent_terminal_message() if reported and success else None}


def shutdown(request: dict[str, Any]) -> dict[str, Any]:
    session_id, parent, mode = _session(request)
    from subagents_runtime.inbox_cleanup import cleanup_inboxes, observe_activity

    observe_activity(session_id, ended=True)
    if parent and mode == "interactive":
        report_child_stop(
            session_id, "", success=False, reason="SessionEnd", cancelled=True,
            execution_id=_execution_id(session_id),
        )
    try:
        cleanup_inboxes(apply=True, grace_hours=0, session_id=session_id)
    except OSError as exc:
        print(f"Inbox cleanup skipped: {exc}", file=sys.stderr)
    return {}


def claim_delivery(request: dict[str, Any]) -> dict[str, Any]:
    session_id, _parent, _mode = _session(request)
    delivery = claim_parent_delivery(session_id, "Stop")
    return {
        "delivery": {"id": delivery.delivery_id, "text": delivery.text} if delivery else None,
        "pending": has_pending_children(session_id),
    }


def ack_delivery(request: dict[str, Any]) -> dict[str, Any]:
    session_id, _parent, _mode = _session(request)
    delivery_id = request.get("deliveryId")
    if not isinstance(delivery_id, str) or not delivery_id:
        raise BridgeError("deliveryId is required")
    return {"acknowledged": acknowledge_parent_delivery(session_id, delivery_id)}


OPERATIONS = {
    "session_start": session_start,
    "prompt": prompt,
    "previous_reply": previous_reply,
    "inbox_scan": inbox_scan,
    # Sessions with an older loaded extension can still use the upgraded runtime.
    "inbox_write": inbox_scan,
    "settled": settled,
    "shutdown": shutdown,
    "claim_delivery": claim_delivery,
    "ack_delivery": ack_delivery,
}


def handle(request: object) -> dict[str, Any]:
    try:
        if not isinstance(request, dict) or request.get("version") != PROTOCOL:
            raise BridgeError("unsupported Pi bridge protocol")
        operation = OPERATIONS.get(request.get("operation"))
        if operation is None:
            raise BridgeError(f"unknown Pi bridge operation {request.get('operation')!r}")
        return {"version": PROTOCOL, "ok": True, **operation(request)}
    except Exception as exc:  # noqa: BLE001 - The extension needs a protocol answer for every failure.
        return {"version": PROTOCOL, "ok": False, "error": runtime_message(str(exc)) or type(exc).__name__}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        request = None
        print(f"Invalid Pi bridge request: {exc}", file=sys.stderr)
    print(json.dumps(handle(request)))
    return 0
