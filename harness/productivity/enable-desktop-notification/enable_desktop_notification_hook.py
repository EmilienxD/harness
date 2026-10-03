#!/usr/bin/env python3
"""Consume the desktop command and notify on opted-in session Stop events."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from desktop_notification import backend_available, send_notification


COMMAND = "/enable-desktop-notification"
PRODUCTS = {"claude": "Claude Code", "chatgpt": "Codex"}


def invocation(payload: dict, provider: str) -> str | None:
    if (provider == "claude" and payload.get("hook_event_name") == "UserPromptExpansion"
            and payload.get("command_name") == COMMAND[1:]):
        return str(payload.get("command_args") or "").strip()
    if payload.get("hook_event_name") != "UserPromptSubmit":
        return None
    words = str(payload.get("prompt") or "").split(maxsplit=1)
    commands = {COMMAND}
    if provider == "chatgpt":
        commands.add("$" + COMMAND[1:])
    if words and words[0] in commands:
        return words[1].strip() if len(words) > 1 else ""
    return None


def session_state(provider: str, session: str) -> Path:
    root = Path(os.environ.get("HARNESS_STATE_DIR") or Path.home() / ".harness").expanduser()
    token = hashlib.sha256(session.encode("utf-8")).hexdigest()
    return root / "desktop-notification" / provider / f"{token}.json"


def preview(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def session_title(payload: dict, provider: str) -> str:
    session = payload["session_id"]
    if provider == "chatgpt":
        root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
        path, identity, title_key = root / "session_index.jsonl", "id", "thread_name"
    else:
        transcript = payload.get("transcript_path")
        if not isinstance(transcript, str) or not transcript:
            return session
        path, identity, title_key = Path(transcript), "sessionId", "aiTitle"
    title = session
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and record.get(identity) == session:
                    candidate = record.get(title_key)
                    if isinstance(candidate, str) and candidate.strip():
                        title = candidate
    except OSError:
        pass
    return title


def handle(payload: dict, provider: str) -> dict:
    """Return hook protocol output; notification delivery is an OS boundary."""
    event = payload.get("hook_event_name")
    args = invocation(payload, provider)
    if args is not None:
        if args not in {"", "--disable"}:
            return {"decision": "block", "reason": f"Usage: {COMMAND} [--disable]"}
        session = payload.get("session_id")
        if not isinstance(session, str) or not session:
            return {"decision": "block", "reason": "Cannot enable notifications: session ID is unavailable."}
        path = session_state(provider, session)
        if args == "--disable":
            path.unlink(missing_ok=True)
            return {"decision": "block", "reason": "Desktop notifications disabled for this session."}
        if not backend_available():
            return {"decision": "block", "reason": "Cannot enable notifications: no desktop notification backend is available."}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
        return {"decision": "block", "reason": "Desktop notifications enabled for this session."}

    session = payload.get("session_id")
    if event != "Stop" or not isinstance(session, str) or not session:
        return {}
    if not session_state(provider, session).is_file():
        return {}
    message = payload.get("last_assistant_message")
    body = preview(message, 240) if isinstance(message, str) and message.strip() else "Turn completed."
    title = preview(session_title(payload, provider), 64)
    send_notification(f"{PRODUCTS[provider]}: {title}", body)
    return {}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    provider = "chatgpt" if "--chatgpt" in args else "claude"
    payload = json.load(sys.stdin)
    try:
        output = handle(payload, provider)
    except Exception as exc:
        if invocation(payload, provider) is not None:
            output = {"decision": "block", "reason": f"Desktop notification command failed: {exc}"}
        else:
            # A notification failure must let the agent finish its turn.
            output = {"systemMessage": f"Desktop notification failed: {exc}"}
    print(json.dumps(output, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
