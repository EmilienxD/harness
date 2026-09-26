"""Read-only progress for headless provider executions."""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from subagents_runtime.storage import connect, state_dir


def aboard_log_path(execution_id: str) -> Path:
    return state_dir() / "runtime" / "watch" / execution_id / "stdout.jsonl"


def _short(value: object, limit: int = 160) -> str:
    if not isinstance(value, str):
        return ""
    clean = " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value).split())
    return clean[: limit - 1] + "…" if len(clean) > limit else clean


def event_summary(event: object) -> str | None:
    """Summarize provider facts without interpreting research quality."""
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    if kind == "assistant":
        message = event.get("message")
        content = message.get("content", []) if isinstance(message, dict) else []
        labels = []
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name = _short(block.get("name")) or "Tool"
                data = block.get("input")
                detail = ""
                if isinstance(data, dict):
                    detail = _short(data.get("query") or data.get("url"))
                labels.append(f"{'Search' if name.lower() in {'websearch', 'web_search'} else name} started" + (f": {detail}" if detail else ""))
            elif block.get("type") == "text":
                detail = _short(block.get("text"))
                if detail:
                    labels.append(f"Agent: {detail}")
        return " | ".join(labels) or None
    if kind == "result":
        label = "Failed" if event.get("is_error") else "Finished"
        usage = event.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("input_tokens"), int) and isinstance(usage.get("output_tokens"), int):
            return f"{label} · {usage['input_tokens']} input, {usage['output_tokens']} output tokens"
        return label
    if kind == "thread.started":
        return "Provider session started"
    if kind == "turn.started":
        return "Turn started"
    if kind == "turn.failed":
        return "Turn failed"
    if kind == "turn.completed":
        usage = event.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("input_tokens"), int) and isinstance(usage.get("output_tokens"), int):
            return f"Turn finished · {usage['input_tokens']} input, {usage['output_tokens']} output tokens"
        return "Turn finished"
    if kind == "error":
        return "Error: " + (_short(event.get("message")) or "provider error")
    if kind in {"item.started", "item.completed", "item.updated"}:
        item = event.get("item")
        if not isinstance(item, dict):
            return None
        item_type = item.get("type")
        started = kind == "item.started"
        done = kind == "item.completed"
        if item_type == "web_search":
            detail = _short(item.get("query") or item.get("url"))
            return ("Search started" if started else "Search finished" if done else "Search updated") + (f": {detail}" if detail else "")
        if item_type == "command_execution":
            detail = _short(item.get("command"))
            return ("Command started" if started else "Command finished" if done else "Command updated") + (f": {detail}" if detail else "")
        if item_type == "mcp_tool_call":
            detail = _short(item.get("tool"))
            return ("Tool started" if started else "Tool finished" if done else "Tool updated") + (f": {detail}" if detail else "")
        if item_type == "agent_message" and done:
            detail = _short(item.get("text"))
            return f"Agent: {detail}" if detail else None
        if item_type == "file_change" and done:
            return "File changes completed"
        if item_type == "plan_update" and done:
            return "Plan updated"
    return None


def _selection(identifier: str):
    from subagents_runtime.sessions import SessionError, resolve_session

    session_id = resolve_session(identifier)
    with connect() as db:
        session = db.execute("SELECT provider,execution_mode,parent_session_id,created_at FROM sessions WHERE id=?", (session_id,)).fetchone()
        if session is None:
            raise SessionError(f"unknown Harness session {identifier}")
        execution = db.execute("SELECT id,backend,state,created_at,started_at,exited_at FROM executions WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (session_id,)).fetchone()
    if execution is None:
        raise SessionError(f"session {identifier} has no execution to watch")
    if session[1] != "auto":
        raise SessionError(f"session {identifier} has a visible terminal; watch is for background sessions")
    log = (aboard_log_path(execution[0]) if execution[1] == "aboard" else state_dir() / "runtime" / "sessions" / (session[2] or session_id) / "executions" / execution[0] / "stdout.jsonl")
    return session_id, session[0], execution[0], log, execution[3]


def choose_current_session() -> str:
    """Use the one running background session in this directory, or name the choices."""
    from subagents_runtime.sessions import SessionError

    with connect() as db:
        rows = db.execute(
            """SELECT s.id,s.provider,COALESCE(r.task,'background')
               FROM sessions s JOIN executions e ON e.session_id=s.id
               LEFT JOIN requests r ON r.id=e.request_id
               WHERE s.cwd=? AND s.execution_mode='auto'
                 AND e.state IN ('prepared','starting','running','uncertain')
                 AND e.superseded_at IS NULL ORDER BY e.created_at DESC""",
            (str(Path.cwd().resolve()),),
        ).fetchall()
    if len(rows) == 1:
        return rows[0][0]
    if not rows:
        raise SessionError("no active background session in this directory; pass a session ID")
    choices = "\n".join(f"  {row[0]}  {row[1]} {row[2]}" for row in rows)
    raise SessionError(f"multiple background sessions are active; choose one:\n{choices}")


def _state(execution_id: str) -> str:
    with connect() as db:
        row = db.execute("SELECT state FROM executions WHERE id=?", (execution_id,)).fetchone()
    return row[0] if row else "unknown"


def _elapsed(started: str) -> str:
    try:
        value = datetime.fromisoformat(started.replace(" ", "T")).replace(tzinfo=timezone.utc)
        seconds = max(0, int((datetime.now(timezone.utc) - value).total_seconds()))
        return f"{seconds // 60}m {seconds % 60}s"
    except ValueError:
        return "unknown"


def watch(identifier: str, *, once: bool = False, poll_seconds: float = 1.0) -> None:
    session_id, provider, execution_id, log, created_at = _selection(identifier)
    print(f"Watching {identifier} ({provider}, session {session_id})")
    offset = 0
    pending = b""
    last_activity: float | None = None
    last_heartbeat = 0.0
    while True:
        try:
            with log.open("rb") as source:
                source.seek(offset)
                chunk = source.read()
                offset = source.tell()
        except FileNotFoundError:
            chunk = b""
        if chunk:
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                try:
                    summary = event_summary(json.loads(line))
                except (ValueError, UnicodeError):
                    summary = None
                if summary:
                    print(summary, flush=True)
                    last_activity = time.monotonic()
        state = _state(execution_id)
        now = time.monotonic()
        if once or state in {"exited", "failed", "cancelled"}:
            print(f"Status: {state} · elapsed {_elapsed(created_at)}", flush=True)
            return
        if now - last_heartbeat >= 30:
            ago = "no events yet" if last_activity is None else f"last event {int(now - last_activity)}s ago"
            print(f"Status: {state} · elapsed {_elapsed(created_at)} · {ago}", flush=True)
            last_heartbeat = now
        time.sleep(poll_seconds)
