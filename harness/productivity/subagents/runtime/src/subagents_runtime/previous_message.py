"""Read the preceding assistant response from a provider's native transcript."""

from __future__ import annotations

import json
from pathlib import Path


class PreviousMessageError(ValueError):
    """The previous assistant response cannot be safely recovered."""


def _text(content: object, kind: str) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block["text"] for block in content
        if isinstance(block, dict) and block.get("type") == kind
        and isinstance(block.get("text"), str)
    )


def read_previous_message(transcript_path: object, provider: str) -> str:
    if not isinstance(transcript_path, str) or not transcript_path:
        raise PreviousMessageError("The session transcript is unavailable; no reply was sent.")
    records = []
    try:
        with Path(transcript_path).open(encoding="utf-8") as source:
            for line in source:
                if not line.strip():
                    continue
                record = json.loads(line)
                if isinstance(record, dict):
                    records.append(record)
    except (OSError, UnicodeError, ValueError) as exc:
        raise PreviousMessageError("The session transcript could not be read; no reply was sent.") from exc
    if provider == "claude":
        message = _claude_message(records)
    else:
        message = _codex_message(records)
    if not message.strip():
        raise PreviousMessageError("There is no previous assistant message to send to the parent.")
    return message


def _claude_message(records: list[dict]) -> str:
    main = [record for record in records if not record.get("isSidechain")]
    by_id = {record["uuid"]: record for record in main if isinstance(record.get("uuid"), str)}
    # Follow the active conversation, excluding detached branches and native subagents.
    leaf = next((record for record in reversed(main) if isinstance(record.get("uuid"), str)), None)
    chain = []
    seen = set()
    while leaf is not None and leaf["uuid"] not in seen:
        seen.add(leaf["uuid"])
        chain.append(leaf)
        leaf = by_id.get(leaf.get("parentUuid"))
    ordered = list(reversed(chain)) if by_id else main
    latest_id = None
    result = ""
    for record in ordered:
        message = record.get("message")
        if (record.get("type") != "assistant" or not isinstance(message, dict)
                or record.get("isApiErrorMessage") or message.get("model") == "<synthetic>"):
            continue
        text = _text(message.get("content"), "text")
        if not text.strip():
            continue
        message_id = message.get("id")
        if message_id is not None and message_id == latest_id:
            result += text
        else:
            result = text
        latest_id = message_id
    return result


def _codex_message(records: list[dict]) -> str:
    result = ""
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "response_item" and payload.get("type") == "message":
            if payload.get("role") == "assistant" and payload.get("phase") in (None, "final_answer"):
                text = _text(payload.get("content"), "output_text")
                if text.strip():
                    result = text
        elif record.get("type") == "event_msg" and payload.get("type") == "task_complete":
            text = payload.get("last_agent_message")
            if isinstance(text, str) and text.strip():
                result = text
    return result
