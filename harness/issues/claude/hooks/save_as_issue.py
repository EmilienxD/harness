#!/usr/bin/env python3
"""Cache Claude's final text and publish it only on /save-as-issue."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import issues_core as core

PROMPT_PATTERN = re.compile(r"^/save-as-issue(?:\s|$)")


def cache_path(payload: dict) -> Path:
    session_id = payload.get("session_id", "")
    if not isinstance(session_id, str) or not core.SESSION_ID_PATTERN.fullmatch(session_id):
        raise ValueError("missing or invalid session ID")
    return Path(payload.get("cwd") or ".") / core.GATEWAY_DIR / ".responses" / f"{session_id}.json"


def invalidate(payload: dict) -> None:
    """A new turn must never publish a stale response if it fails or is interrupted."""
    cache_path(payload).unlink(missing_ok=True)


def capture(payload: dict) -> None:
    if payload.get("agent_id"):
        return
    path = cache_path(payload)
    body = payload.get("last_assistant_message")
    if not isinstance(body, str) or not body.strip():
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    ignore = core.GATEWAY_DIR / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    previous = core._read_json_dict(path)
    # Stop can fire again when another hook requests continuation.
    if previous.get("body") == body:
        return
    core._write_json_dict(path, {"id": str(uuid.uuid4()), "body": body})


def session_title(transcript_path: str, session_id: str) -> str:
    """AI title records are internal, optional metadata; never infer one from prose."""
    title = ""
    try:
        with Path(transcript_path).open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") != "ai-title" or record.get("sessionId") != session_id:
                    continue
                value = record.get("aiTitle")
                if isinstance(value, str) and value.strip():
                    title = " ".join(value.split())
    except OSError:
        pass
    return title


def save(payload: dict) -> str:
    if payload.get("prompt", "").strip() != "/save-as-issue":
        return "Usage: /save-as-issue (no arguments)."
    path = cache_path(payload)
    if not path.exists():
        return "No completed response cached. Finish a Claude response after installing issues, then run /save-as-issue."
    with core.file_lock(path.with_suffix(".lock")) as acquired:
        if not acquired:
            return "This session is already saving a response; retry when it finishes."
        cached = core._read_json_dict(path)
        body, response_id = cached.get("body"), cached.get("id")
        if not isinstance(body, str) or not body.strip() or not isinstance(response_id, str):
            return "No valid completed response cached; finish another Claude response first."
        session_id = payload["session_id"]
        key = f"save-{session_id}/{response_id}"
        with core._locked_state(core.GATEWAY_DIR) as (state_path, state):
            if state_path is None:
                return "Issue state is busy; retry /save-as-issue."
            published = state.get("published", {}).get(key)
            inflight = state.get("inflight", {}).get(key)
        if published and not inflight:
            return f"Already saved: {published['url']}"
        # Freeze the title on first publication, including after partial failures.
        if inflight:
            title = inflight["title"]
        else:
            title = f"Report {session_id}"
            generated = session_title(str(payload.get("transcript_path") or ""), session_id)
            if generated:
                title += f" — {generated}"
            title = title[:256]
        report: list[str] = []
        ok, record, error = core.publish_reserved_issue(
            key=key, title=title, body=body, labels=[], parent=None,
            gateway_dir=core.GATEWAY_DIR, report=report,
        )
        if not ok:
            report.append(f"Save failed: {error}. Retry /save-as-issue to recover.")
        elif not core.finish_inflight(key, core.GATEWAY_DIR):
            report.append(f"Saved: {record['url']}; retry to finish recording completion.")
        else:
            report.append(f"Saved: {record['url']}")
        return "\n".join(report)


def handle_save(payload: dict) -> None:
    token = core.GH_DEADLINE.set(time.monotonic() + 240)
    try:
        result = save(payload)
    except subprocess.TimeoutExpired:
        result = "GitHub operation timed out. Retry /save-as-issue to recover any partial publication."
    except Exception as exc:
        result = f"Save failed: {exc}. Retry /save-as-issue; no model fallback was invoked."
    finally:
        core.GH_DEADLINE.reset(token)
    sys.stderr.write("\n\n" + result + "\n")
    raise SystemExit(2)


def main() -> None:
    payload = json.load(sys.stdin)
    if payload.get("agent_id"):
        return
    if payload.get("cwd"):
        os.chdir(payload["cwd"])
    try:
        if payload.get("hook_event_name") == "Stop":
            capture(payload)
        elif payload.get("hook_event_name") in ("SessionStart", "StopFailure"):
            invalidate(payload)
    except Exception as exc:
        # Cache maintenance must never request another model turn.
        sys.stderr.write(f"save-as-issue response cache unavailable: {exc}\n")


if __name__ == "__main__":
    main()
