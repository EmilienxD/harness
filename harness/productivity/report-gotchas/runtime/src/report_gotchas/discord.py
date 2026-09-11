from __future__ import annotations

from datetime import datetime
from typing import Any, Callable
import json
import urllib.error
import urllib.request
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from report_gotchas.reports import QueuedReport, delete_queued, load_queued, save_queued


MESSAGE_BODY_LIMIT = 1800


def _inline(value: str) -> str:
    return value.replace("`", "'").replace("\r", " ").replace("\n", " ")


def _webhook_with_wait(url: str) -> str:
    parsed = urlsplit(url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["wait"] = "true"
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def _discord_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _fitting_index(value: str, limit: int) -> int:
    units = 0
    for index, character in enumerate(value):
        units += 2 if ord(character) > 0xFFFF else 1
        if units > limit:
            return index
    return len(value)


def _header(report: QueuedReport) -> str:
    import os

    provider = "Codex" if report.provider == "chatgpt" else "Claude"
    timestamp = int(datetime.fromisoformat(report.reported_at).timestamp())
    project = os.path.basename(report.cwd)

    lines = [
        "**Agent gotchas**",
        f"**{provider}:** {_inline(report.session_id)}",
        f"**Date:** <t:{timestamp}:F>",
        f"**Project:** {_inline(project)}",
    ]

    git = report.git
    if not git.root:
        lines.append(f"**Git:** {git.status}")
    else:
        lines.append(f"**Git:** {_inline(git.branch)} @ {_inline(git.commit[:12])}")

        if git.remote:
            lines.append(f"**Origin:** {_inline(git.remote)}")

        if git.status:
            lines.extend(_inline(line) for line in git.status.splitlines())

    return "\n".join(lines)


def _split(text: str, limit: int = MESSAGE_BODY_LIMIT) -> list[str]:
    remaining = text.strip()
    chunks: list[str] = []

    while remaining:
        if _discord_length(remaining) <= limit:
            chunks.append(remaining)
            break

        fitting = _fitting_index(remaining, limit)
        boundary = remaining.rfind("\n", 0, fitting + 1)

        if boundary < fitting // 2:
            boundary = remaining.rfind(" ", 0, fitting + 1)

        if boundary < fitting // 2:
            boundary = fitting

        chunks.append(remaining[:boundary].rstrip())
        remaining = remaining[boundary:].lstrip()

    return chunks


def messages(report: QueuedReport) -> list[str]:
    chunks = _split(f"{_header(report)}\n\n\n{report.message}")

    if len(chunks) == 1:
        return chunks

    return [
        chunk if index == 0 else f"**Agent gotchas · {index + 1}/{len(chunks)}**\n\n{chunk}"
        for index, chunk in enumerate(chunks)
    ]


def deliver(
    receipt: str,
    webhook_url: str,
    *,
    post: Callable[[str, dict[str, Any]], None] | None = None,
) -> None:
    report = load_queued(receipt)
    parts = messages(report)
    url = _webhook_with_wait(webhook_url)
    sender = post or post_json

    for index in range(report.next_message, len(parts)):
        sender(url, {"content": parts[index], "allowed_mentions": {"parse": []}})
        report = save_queued(report, next_message=index + 1)

    delete_queued(receipt)


class DeliveryError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        retry_after: float | None = None,
    ):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after


def post_json(url: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "harness-report-gotchas/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        retry_after = None

        if exc.code == 429:
            try:
                retry_after = float(
                    json.loads(exc.read().decode("utf-8"))["retry_after"]
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                header = exc.headers.get("Retry-After")
                retry_after = float(header) if header else None

        raise DeliveryError(
            f"Discord webhook returned HTTP {exc.code}",
            retryable=exc.code == 429 or 500 <= exc.code < 600,
            retry_after=retry_after,
        ) from None

    except (OSError, urllib.error.URLError) as exc:
        raise DeliveryError(
            "Discord webhook could not be reached",
            retryable=True,
        ) from exc
