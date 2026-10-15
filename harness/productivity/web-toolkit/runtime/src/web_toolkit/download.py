"""Plain HTTP retrieval with a real browser's TLS and header fingerprint."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin

from curl_cffi import requests

MAX_BYTES = 25 * 1024 * 1024
TIMEOUT = 30
# Prefer Markdown from servers that negotiate it, as Claude Code's WebFetch does.
ACCEPT = "text/markdown;q=1.0, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8"


@dataclass(frozen=True)
class Response:
    url: str
    status: int
    content_type: str
    charset: str | None
    body: bytes
    truncated: bool


def redirect_target(url: str, timeout: float = 10) -> str | None:
    """Return where ``url`` redirects to, without following it; None when it does not."""
    try:
        response = requests.get(url, impersonate="chrome", timeout=timeout, allow_redirects=False)
    except Exception:
        return None
    location = response.headers.get("location") if 300 <= response.status_code < 400 else None
    return urljoin(url, location) if location else None


def get(url: str) -> Response:
    response = requests.get(
        url, impersonate="chrome", headers={"Accept": ACCEPT}, timeout=TIMEOUT,
        allow_redirects=True, max_redirects=10, stream=True,
    )
    try:
        chunks: list[bytes] = []
        size = 0
        truncated = False
        for chunk in response.iter_content():
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                truncated = True
                break
        body = b"".join(chunks)[:MAX_BYTES]
    finally:
        response.close()
    header = response.headers.get("content-type", "")
    media_type, _, parameters = header.partition(";")
    charset = next(
        (value.strip().strip('"') for key, _, value in (part.partition("=") for part in parameters.split(";"))
         if key.strip().lower() == "charset"),
        None,
    )
    return Response(str(response.url), response.status_code, media_type.strip().lower(), charset, body, truncated)
