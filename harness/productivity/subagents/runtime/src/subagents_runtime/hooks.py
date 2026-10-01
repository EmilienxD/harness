"""Provider hooks for saved-conversation delegation, context, and results."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from subagents_runtime import sessions
from subagents_runtime.delegation import (
    arm_reply,
    claim_instructions,
    claim_parent_delivery,
    clear_reply_authorization,
    enable_delegation,
    lead_instructions,
    observe_parent_event,
    process_inbox,
    reconcile_inbox,
    report_child_stop,
    wait_parent_delivery,
)

SKILL_NAME = r"((?:work|explore|prototype|websearch|brainstorm|address|review)-with-agent|reply-to-agent|resume-agent|ship)"
SHIP_INVOCATION = re.compile(r"(?<!\S)(?:[/$]ship|\[\$ship\]\([^\r\n]+\))(?=\s|$)")
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


def _skill_instructions(session_id: str, skill: str) -> str | None:
    inbox = enable_delegation(session_id, skill).inbox
    if skill != "ship":
        return claim_instructions(session_id, lead=False)
    # Every /ship invocation restates the Lead identity, even when already injected.
    return claim_instructions(session_id, lead=True) or lead_instructions(session_id, inbox)


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
                paths.add(Path(value).absolute())
    if tool in {"apply_patch", "ApplyPatch"}:
        for text in _strings(tool_input):
            for match in re.finditer(
                r"^\*\*\* (?:Add|Update) File: (.+)$", text, re.MULTILINE
            ):
                paths.add(Path(match.group(1).strip()).absolute())
    return sorted(paths)


def _inbox_for_path(session_id: str, path: Path) -> str | None:
    with sessions._connect() as connection:
        rows = connection.execute(
            "SELECT parent_session_id, inbox FROM session_delegation WHERE parent_session_id = ?",
            (session_id,),
        ).fetchall()
    for inbox_session_id, inbox in rows:
        try:
            if path.parent == Path(inbox).resolve():
                return str(inbox_session_id)
        except OSError:
            continue
    return None


def _forked_child(execution_id: str | None, conversation: str) -> str | None:
    """The delegated identity a Harness-started fork carries on, if this is one.

    A fork this runtime launched keeps the child's agent-i identity and simply speaks
    through the copied conversation. A fork the user starts inside the terminal is a
    conversation of their own and must never inherit that identity.
    """
    if not execution_id:
        return None
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT session_id FROM executions WHERE id=? AND fork_of IS NOT NULL AND superseded_at IS NULL AND state IN ('prepared','starting','running','uncertain')",
            (execution_id,),
        ).fetchone()
        if row is None:
            return None
        bound = connection.execute(
            "SELECT provider_session_id FROM sessions WHERE id=?", (row[0],)
        ).fetchone()
        if bound is None or bound[0] not in (None, conversation):
            return None
        connection.execute(
            "UPDATE sessions SET provider_session_id=? WHERE id=?", (conversation, row[0])
        )
        return row[0]


def _stop_wait_seconds(cwd: Path) -> float:
    try:
        value = sessions.launch_configuration(cwd)
        session = value.get("session", {}) if isinstance(value, dict) else {}
        hours = session.get("stopWaitHours", 24) if isinstance(session, dict) else 24
        return max(0.0, float(hours) * 3600)
    except (sessions.SessionError, ValueError, TypeError):
        return 24 * 3600


def _processing_context(processed) -> str:
    labels = []
    with sessions._connect() as connection:
        for item in processed:
            row = connection.execute(
                "SELECT agent_index FROM sessions WHERE id=?", (item.child_session_id,)
            ).fetchone()
            label = f"agent-{row[0]}" if row else item.path.name
            labels.append(
                f"{label}: {item.status}" + (f" ({item.reason})" if item.reason else "")
            )
    return "\n".join(labels)


def _parent_terminal_message() -> str | None:
    uri = os.environ.get("HARNESS_PARENT_TERMINAL_URI", "").strip()
    if not uri or len(uri) > 4096 or any(character in uri for character in "\r\n"):
        return None
    return f"Reply sent to the parent. Return to the main agent: {uri}"


def handle(
    payload: dict[str, Any], provider: str | None = None
) -> dict[str, Any] | None:
    event = str(payload.get("hook_event_name", ""))
    session_id = payload.get("session_id") or os.environ.get("HARNESS_SESSION_ID")
    if not isinstance(session_id, str):
        return None
    cwd = Path(payload.get("cwd") or Path.cwd())
    selected_provider = provider or os.environ.get("HARNESS_PROVIDER", "claude")
    execution_mode = os.environ.get("HARNESS_EXECUTION_MODE", "interactive")
    execution_id = os.environ.get("HARNESS_EXECUTION_ID")
    fresh = event == "SessionStart" and payload.get("source") in {"clear", "fork"}
    continued = (
        _forked_child(execution_id, session_id)
        if event == "SessionStart" and payload.get("source") == "fork"
        else None
    )
    if continued:
        session_id = continued
    elif fresh:
        # Providers assign a fresh conversation ID. Never bind it to an inherited parent ID.
        sessions.register_observed(session_id, cwd, selected_provider, execution_mode)
    else:
        session_id = sessions.bind_observed(
            session_id, cwd, selected_provider, execution_mode
        )
    observe_parent_event(session_id, event)
    from subagents_runtime import loop
    loop.observe_event(session_id, event, payload.get("prompt"))
    if event == "SessionStart" and execution_id and (continued or not fresh):
        from subagents_runtime.processes import confirm_startup

        confirm_startup(execution_id)
    if event == "SessionStart":
        recovered = []
        with sessions._connect() as connection:
            enabled = connection.execute(
                "SELECT 1 FROM session_delegation WHERE parent_session_id=?",
                (session_id,),
            ).fetchone()
        if enabled:
            recovered = reconcile_inbox(session_id, launch=sessions.launch_delegated)
            from subagents_runtime.processes import live_executions

            with sessions._connect() as connection:
                children = connection.execute(
                    "SELECT DISTINCT child_session_id FROM requests WHERE parent_session_id=? AND child_session_id IS NOT NULL AND state IN ('launching','pending','uncertain')",
                    (session_id,),
                ).fetchall()
            for (child_id,) in children:
                live_executions(child_id)
        instructions = claim_instructions(
            session_id, compact=payload.get("source") == "compact"
        )
        delivery = claim_parent_delivery(session_id, event)
        text = "\n\n".join(
            item
            for item in (
                instructions,
                delivery.text if delivery else None,
                _processing_context(recovered) if recovered else None,
            )
            if item
        )
        return _context(event, text) if text else None

    if event == "UserPromptSubmit":
        # Codex has no StopFailure event. A new user turn is proof that a
        # previously armed turn did not complete successfully, so expire the
        # one-shot before optionally arming this prompt's reply.
        clear_reply_authorization(session_id)
        delivery = claim_parent_delivery(session_id, event)
        prompt = payload.get("prompt")
        pattern = INVOCATIONS[selected_provider]
        match = pattern.search(prompt) if isinstance(prompt, str) else None
        if match or (isinstance(prompt, str) and SHIP_INVOCATION.search(prompt)):
            skill = match.group(1) if match else "ship"
            if skill == "reply-to-agent":
                arm_reply(session_id, execution_id)
                context = (
                    "Reply armed. The next successful Stop will be sent to the parent."
                )
                return _context(
                    event,
                    context if delivery is None else f"{delivery.text}\n\n{context}",
                )
            instructions = _skill_instructions(session_id, skill)
            text = "\n\n".join(
                item
                for item in (
                    instructions,
                    delivery.text if delivery else None,
                )
                if item
            )
            return _context(event, text) if text else None
        instructions = claim_instructions(session_id)
        text = "\n\n".join(
            item for item in (instructions, delivery.text if delivery else None) if item
        )
        if text:
            return _context(event, text)

    if event == "PreToolUse":
        return None

    if event == "Interrupt":
        clear_reply_authorization(session_id)
        return None

    if event == "PostToolUse":
        response = payload.get("tool_response")
        if isinstance(response, dict) and (
            response.get("isError") or response.get("error")
        ):
            return None
        tool_input = payload.get("tool_input")
        skill = tool_input.get("skill") if isinstance(tool_input, dict) else None
        if (
            payload.get("tool_name") == "Skill"
            and isinstance(skill, str)
            and re.fullmatch(SKILL_NAME, skill)
        ):
            if skill == "reply-to-agent":
                arm_reply(session_id, execution_id)
            else:
                instructions = _skill_instructions(session_id, skill)
                if instructions:
                    return _context(event, instructions)
        processed = []
        for path in _written_paths(payload):
            inbox_session_id = _inbox_for_path(session_id, path)
            if inbox_session_id is not None:
                processed.extend(
                    process_inbox(
                        inbox_session_id,
                        launch=sessions.launch_delegated,
                        request_paths={path},
                    )
                )
        delivery = claim_parent_delivery(session_id, event)
        if delivery is not None:
            return _context(event, delivery.text)
        if processed:
            return _context(event, _processing_context(processed))
        return None

    if event in {"Stop", "StopFailure", "SessionEnd"}:
        message = payload.get("last_assistant_message")
        if not isinstance(message, str):
            message = ""
        success = event == "Stop" and bool(message.strip())
        if loop.is_implementer(session_id):
            if not success:
                return None
            feedback = loop.report_and_wait(
                session_id, message, payload.get("transcript_path"), selected_provider,
                timeout_seconds=_stop_wait_seconds(cwd),
            )
            if feedback is None:
                return None
            return (_context(event, feedback) if selected_provider == "claude"
                    else {"decision": "block", "reason": feedback})
        reported = report_child_stop(
            session_id,
            message,
            success=success,
            reason=None if success else str(payload.get("reason") or event),
            cancelled=event == "SessionEnd",
            execution_id=execution_id,
        )
        parent_terminal_message = (
            _parent_terminal_message()
            if reported and success and execution_mode == "interactive"
            else None
        )
        if event == "Stop":
            delivery = wait_parent_delivery(
                session_id,
                timeout_seconds=_stop_wait_seconds(
                    Path(payload.get("cwd") or Path.cwd())
                ),
            )
            if delivery is not None:
                if selected_provider == "claude":
                    response = _context(event, delivery.text)
                else:
                    response = {"decision": "block", "reason": delivery.text}
                if parent_terminal_message is not None:
                    response["systemMessage"] = parent_terminal_message
                return response
        if parent_terminal_message is not None:
            return {"systemMessage": parent_terminal_message}
        return None

    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        provider = provider_from_argv(sys.argv[1:])
        output = handle(payload, provider) if isinstance(payload, dict) else None
        if output is not None:
            print(json.dumps(output))
    except Exception as exc:  # noqa: BLE001 - Provider entrypoint reports hook failures without a traceback.
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
