#!/usr/bin/env python3
"""Native ChatGPT adapter for issue drafting context and publishing."""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path

import copy_message_as_issue
import issues_core as core

PUBLISH_PATTERN = re.compile(r"(?<![\w-])[$@/]publish-issues?(?=\s|$)")
COPY_PATTERN = re.compile(r"(?<![\w-])[$@/]copy-message-as-issue(?=\s|$)")


def gateway_session_id(session_id: str) -> str:
    """Map ChatGPT thread ids to the UUID form used by draft references."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:chatgpt:{session_id}"))


def _additional_context(text: str) -> None:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": text,
            }
        },
        sys.stdout,
    )


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = str(payload.get("prompt") or "").strip()
    event = payload.get("hook_event_name")
    if event == "Stop":
        copy_message_as_issue.capture(payload)
        json.dump({}, sys.stdout)
        return
    if event in {"SessionStart", "SessionEnd", "Interrupt"}:
        copy_message_as_issue.invalidate(payload)
        return

    cwd = Path(str(payload.get("cwd") or ".")).resolve()
    os.chdir(cwd)

    if COPY_PATTERN.search(prompt):
        result = copy_message_as_issue.save(payload)
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    if PUBLISH_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "")
        result = core.run_publish_command(prompt, gateway_session_id(session_id))
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    try:
        copy_message_as_issue.invalidate(payload)
    except (OSError, ValueError):
        pass

    contexts: list[str] = []
    try:
        notice = core.flush_notice()
    except Exception:  # noqa: BLE001 - damaged notices never block prompts
        notice = None
    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "unknown")
        try:
            contexts.append(
                core.prepare_drafting_context(cwd, gateway_session_id(session_id))
            )
        except Exception as exc:  # Drafting cannot safely continue without it.
            sys.stderr.write(f"issues gateway setup failed: {exc}")
            raise SystemExit(2) from exc

    if contexts:
        _additional_context("\n\n".join(contexts))


def entrypoint() -> None:
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"harness issues hook failed in ChatGPT: {exc}")
        raise SystemExit(2) from exc


if __name__ == "__main__":
    entrypoint()
