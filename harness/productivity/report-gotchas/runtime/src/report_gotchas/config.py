"""User-owned Discord webhook configuration."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit


class ReportError(RuntimeError):
    pass


def config_path() -> Path:
    configured = os.environ.get("HARNESS_REPORT_GOTCHAS_STATE_DIR")
    directory = Path(configured).expanduser() if configured else Path.home() / ".harness" / "report-gotchas"
    return directory / "config.json"


def validate_webhook_url(value: str) -> str:
    url = value.strip()
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not (host == "discord.com" or host.endswith(".discord.com"))
        or not parsed.path.startswith("/api/webhooks/")
    ):
        raise ReportError("expected an HTTPS discord.com API webhook URL")
    return url


def save_webhook_url(value: str) -> Path:
    url = validate_webhook_url(value)
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 1, "webhook_url": url}), encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    temporary.replace(path)
    return path


def webhook_url() -> str | None:
    environment = os.environ.get("HARNESS_REPORT_GOTCHAS_WEBHOOK_URL")
    if environment:
        return validate_webhook_url(environment)
    path = config_path()
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError
        return validate_webhook_url(value["webhook_url"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ReportError(f"invalid report-gotchas configuration at {path}") from exc
