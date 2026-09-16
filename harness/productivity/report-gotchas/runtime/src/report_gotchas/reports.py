"""Durable report receipts."""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


class ReportError(RuntimeError):
    pass


@dataclass(frozen=True)
class Draft:
    receipt: str
    message: str


@dataclass(frozen=True)
class GitState:
    root: str
    branch: str
    commit: str
    status: str
    remote: str


@dataclass(frozen=True)
class QueuedReport:
    receipt: str
    message: str
    session_id: str
    provider: str
    cwd: str
    reported_at: str
    git: GitState
    next_message: int = 0


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_REPORT_GOTCHAS_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".harness" / "report-gotchas"


def _draft_path(receipt: str) -> Path:
    if not receipt or any(character not in "0123456789abcdef" for character in receipt):
        raise ReportError("invalid report receipt")
    return state_dir() / "drafts" / f"{receipt}.json"


def _queue_path(receipt: str) -> Path:
    _draft_path(receipt)
    return state_dir() / "queue" / f"{receipt}.json"


def _write_json(destination: Path, value: dict[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(destination)


def submit(message: str) -> str:
    if not message.strip():
        raise ReportError("report message is empty")
    receipt = uuid.uuid4().hex
    destination = _draft_path(receipt)
    _write_json(destination, {"version": 1, "receipt": receipt, "message": message})
    return receipt


def load_draft(receipt: str) -> Draft:
    path = _draft_path(receipt)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReportError(f"could not load report receipt {receipt}") from exc
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or value.get("receipt") != receipt
        or not isinstance(value.get("message"), str)
    ):
        raise ReportError(f"invalid report receipt {receipt}")
    return Draft(receipt, value["message"])


def _git(cwd: Path) -> GitState:
    def run(*arguments: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(cwd), *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return result.stdout.strip() if result.returncode == 0 else ""

    try:
        root = run("rev-parse", "--show-toplevel")
        if not root:
            return GitState("", "", "", "Not a Git worktree", "")
        branch = run("symbolic-ref", "--quiet", "--short", "HEAD") or "detached"
        remote = run("config", "--get", "remote.origin.url")
        parsed = urlsplit(remote)
        if parsed.scheme and parsed.hostname and (parsed.username or parsed.password):
            host = parsed.hostname
            if parsed.port:
                host = f"{host}:{parsed.port}"
            remote = urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))
        return GitState(
            root=root,
            branch=branch,
            commit=run("rev-parse", "HEAD"),
            status=run("status", "--short", "--branch", "--untracked-files=all"),
            remote=remote,
        )
    except (OSError, subprocess.SubprocessError):
        return GitState("", "", "", "Git status unavailable", "")


def finalize(receipt: str, session_id: str, cwd: Path, provider: str) -> QueuedReport:
    draft = load_draft(receipt)
    queued = QueuedReport(
        receipt=receipt,
        message=draft.message,
        session_id=session_id,
        provider=provider,
        cwd=str(cwd.resolve()),
        reported_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        git=_git(cwd),
    )
    save_queued(queued)
    _draft_path(receipt).unlink()
    return queued


def load_queued(receipt: str) -> QueuedReport:
    path = _queue_path(receipt)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        git = value["git"]
        return QueuedReport(
            receipt=value["receipt"],
            message=value["message"],
            session_id=value["session_id"],
            provider=value["provider"],
            cwd=value["cwd"],
            reported_at=value["reported_at"],
            git=GitState(**git),
            next_message=int(value.get("next_message", 0)),
        )
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise ReportError(f"could not load queued report {receipt}") from exc


def save_queued(report: QueuedReport, *, next_message: int | None = None) -> QueuedReport:
    updated = replace(report, next_message=next_message) if next_message is not None else report
    value = asdict(updated)
    value["version"] = 1
    _write_json(_queue_path(updated.receipt), value)
    return updated


def delete_queued(receipt: str) -> None:
    try:
        _queue_path(receipt).unlink()
    except FileNotFoundError:
        pass


def queued_receipts() -> list[str]:
    root = state_dir() / "queue"
    try:
        return sorted(path.stem for path in root.glob("*.json") if len(path.stem) == 32)
    except OSError:
        return []
