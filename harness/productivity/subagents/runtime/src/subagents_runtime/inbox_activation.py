"""Explicit inbox activation for provider-owned conversations."""

from __future__ import annotations

import os
import sys

from subagents_runtime import sessions
from subagents_runtime.delegation import enable_delegation


def current_session() -> str:
    provider = os.environ.get("HARNESS_PROVIDER")
    native_ids = {
        "claude": os.environ.get("CLAUDE_CODE_SESSION_ID"),
        "chatgpt": os.environ.get("CODEX_THREAD_ID"),
        "pi": os.environ.get("HARNESS_PI_SESSION_ID"),
    }
    if provider not in native_ids:
        available = [(name, value) for name, value in native_ids.items() if value]
        if len(available) != 1:
            raise sessions.SessionError("Cannot identify the current provider conversation")
        provider, native_id = available[0]
    else:
        native_id = native_ids[provider]
    if not native_id:
        raise sessions.SessionError("The current provider did not supply its conversation identity")
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT id FROM sessions WHERE provider=? AND provider_session_id=?",
            (provider, native_id),
        ).fetchone()
    if row is None:
        raise sessions.SessionError("The current conversation is not registered; check the Subagents provider integration")
    return row[0]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    try:
        inbox = enable_delegation(current_session(), "subagents-toolkit").inbox
        print(f"Successfully enabled inbox {inbox}.")
    except (sessions.SessionError, OSError) as exc:
        print(f"Cannot enable the subagents inbox: {exc}", file=sys.stderr)
        return 1
    return 0
