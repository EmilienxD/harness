#!/usr/bin/env python3
"""Native ChatGPT adapter for the shared issues publisher.

ChatGPT does not expand Claude Code's ``!`command``` skill syntax.  For the
explicit drafting skills, this UserPromptSubmit hook performs that setup and
adds the resulting session id and next draft index as developer context.
Publishing delegates to issues_core so both platforms share exactly the same
GitHub behavior, including resumable oversized issues.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path

import issues_core as core

PUBLISH_PATTERN = re.compile(r"(?<![\w-])[$@/]publish-issues?(?=\s|$)")
DRAFT_PATTERN = re.compile(
    r"(?<![\w-])[$@/](draft-issue|draft-issues|to-spec-draft-issue)(?=\s|$)"
)


def gateway_session_id(session_id: str) -> str:
    """Map ChatGPT thread ids to the UUID form used by draft references."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:chatgpt:{session_id}"))


def prepare_drafting_context(root: Path, session_id: str) -> str:
    """Create the gateway batch and return deterministic skill context."""
    batch_id = gateway_session_id(session_id)
    gateway = root / ".issues-gateway"
    batch = gateway / batch_id
    batch.mkdir(parents=True, exist_ok=True)
    ignore = gateway / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8", newline="\n")

    indexes = []
    for path in batch.glob("issue-*.md"):
        match = core.FILENAME_PATTERN.match(path.name)
        if match:
            indexes.append(int(match.group(1)))
    next_index = max(indexes, default=-1) + 1
    relative = Path(".issues-gateway") / batch_id
    return (
        "Issues gateway drafting context (prepared before the skill loaded):\n"
        f"- issues session id: {batch_id}\n"
        f"- draft directory: {relative.as_posix()}\n"
        f"- next free issue index: {next_index}\n"
        "Use these exact values wherever the skill asks for its session id, "
        "draft directory, or starting issue index. The directory and gateway "
        ".gitignore already exist; do not recompute them."
    )


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
    cwd = Path(str(payload.get("cwd") or ".")).resolve()
    os.chdir(cwd)

    if PUBLISH_PATTERN.search(prompt):
        dry = "--dry" in prompt.split()
        session_id = str(payload.get("session_id") or "")
        result = core.publish_issues(dry, gateway_session_id(session_id))
        sys.stderr.write("\n\n" + result)
        # UserPromptSubmit exit 2 blocks the command prompt, so publishing
        # costs no model turn just as it does in Claude Code.
        raise SystemExit(2)

    contexts: list[str] = []
    try:
        notice = core.flush_notice()
    except Exception:  # noqa: BLE001 - damaged notices never block prompts
        notice = None
    if notice:
        contexts.append(notice)

    if DRAFT_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "unknown")
        try:
            contexts.append(prepare_drafting_context(cwd, session_id))
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
