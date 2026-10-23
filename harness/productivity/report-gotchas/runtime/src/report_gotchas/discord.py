"""Synchronous Discord webhook delivery without local report storage."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


MESSAGE_BODY_LIMIT = 2000


class DeliveryError(RuntimeError):
    pass


def _discord_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _fitting_index(value: str, limit: int) -> int:
    units = 0
    for index, character in enumerate(value):
        units += 2 if ord(character) > 0xFFFF else 1
        if units > limit:
            return index
    return len(value)


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


def deliver(message: str, webhook_url: str) -> None:
    parts = _split(message)
    parsed = urlsplit(webhook_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["wait"] = "true"
    url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    for index, part in enumerate(parts):
        try:
            post_json(url, {"content": part, "allowed_mentions": {"parse": []}})
        except DeliveryError as exc:
            if index:
                raise DeliveryError(f"{exc}; {index} of {len(parts)} report parts were already posted") from None
            raise


def post_json(url: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "harness-report-gotchas/2.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            confirmation = json.loads(response.read().decode("utf-8"))
        if not isinstance(confirmation, dict) or not isinstance(confirmation.get("id"), str) or not confirmation["id"]:
            raise DeliveryError("Discord did not confirm the posted message")
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise DeliveryError("Discord rate limit reached; wait before submitting again") from None
        raise DeliveryError(f"Discord webhook returned HTTP {exc.code}") from None
    except (OSError, urllib.error.URLError):
        raise DeliveryError("Discord webhook could not be reached; delivery could not be confirmed") from None
    except (ValueError, UnicodeError):
        raise DeliveryError("Discord returned an invalid message confirmation") from None
