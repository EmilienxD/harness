#!/usr/bin/env python3
"""Publish the latest completed assistant response as a GitHub issue."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


PROMPT_PATTERN = re.compile(r"^/copy-message-as-issue(?:\s|$)")
CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60


def _session_id(payload: dict) -> str:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("missing or invalid session ID")
    return session_id


def _cache_root() -> Path:
    configured = os.environ.get("HARNESS_COPY_MESSAGE_CACHE_DIR")
    return (
        Path(configured)
        if configured
        else Path(tempfile.gettempdir()) / "harness-copy-message-as-issue"
    )


def _cache_directory(payload: dict) -> Path:
    workspace = os.path.normcase(str(Path(payload.get("cwd") or ".").resolve()))
    workspace_id = hashlib.sha256(workspace.encode("utf-8")).hexdigest()[:16]
    return _cache_root() / workspace_id


def cache_path(payload: dict) -> Path:
    session_id = _session_id(payload)
    session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return _cache_directory(payload) / f"{session_key}.json"


def _read_json_dict(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_dict(path: Path, data: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _remove_empty_cache_directory(payload: dict) -> None:
    directory = _cache_directory(payload)
    try:
        directory.rmdir()
        directory.parent.rmdir()
    except OSError:
        pass


def sweep(payload: dict, now: float | None = None) -> None:
    """Remove abandoned response caches after a bounded retention period."""
    cutoff = (time.time() if now is None else now) - CACHE_MAX_AGE_SECONDS
    try:
        directories = [
            path
            for path in _cache_root().iterdir()
            if path.is_dir() and re.fullmatch(r"[0-9a-f]{16}", path.name)
        ]
    except OSError:
        return
    for directory in directories:
        try:
            paths = list(directory.iterdir())
        except OSError:
            continue
        for path in paths:
            if not re.fullmatch(r"[0-9a-f]{64}\.(?:json|tmp)", path.name):
                continue
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            directory.rmdir()
        except OSError:
            pass
    try:
        _cache_root().rmdir()
    except OSError:
        pass


def invalidate(payload: dict) -> None:
    """Prevent a failed, interrupted, or new turn from exposing a stale response."""
    cache_path(payload).unlink(missing_ok=True)
    _remove_empty_cache_directory(payload)


def capture(payload: dict) -> None:
    if payload.get("agent_id"):
        return
    sweep(payload)
    path = cache_path(payload)
    body = payload.get("last_assistant_message")
    if not isinstance(body, str) or not body.strip():
        invalidate(payload)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = _read_json_dict(path)
    if previous.get("body") == body:
        return
    _write_json_dict(path, {"body": body})


def session_title(transcript_path: str, session_id: str) -> str:
    """Read Claude's optional generated title without inferring one from prose."""
    title = ""
    try:
        with Path(transcript_path).open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") != "ai-title" or record.get("sessionId") != session_id:
                    continue
                value = record.get("aiTitle")
                if isinstance(value, str) and value.strip():
                    title = " ".join(value.split())
    except OSError:
        pass
    return title


def gh_create_issue(title: str, body: str) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8", newline="\n"
    ) as temporary:
        temporary.write(body)
        body_path = temporary.name
    try:
        result = subprocess.run(
            ["gh", "issue", "create", "--title", title, "--body-file", body_path],
            capture_output=True,
            text=True,
            timeout=240,
        )
    finally:
        Path(body_path).unlink(missing_ok=True)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    output = result.stdout.strip()
    url = output.splitlines()[-1] if output else ""
    if not re.fullmatch(r"https://[^/]+/[^/]+/[^/]+/issues/\d+", url):
        return False, "gh returned no valid issue URL"
    return True, url


def save(payload: dict) -> str:
    prompt = str(payload.get("prompt") or "").strip()
    if prompt not in {"/copy-message-as-issue", "$copy-message-as-issue", "@copy-message-as-issue"}:
        return "Usage: copy-message-as-issue (no arguments)."
    path = cache_path(payload)
    cached = _read_json_dict(path)
    body = cached.get("body")
    if not isinstance(body, str) or not body.strip():
        return "No completed response is available to copy."
    session_id = _session_id(payload)
    title = f"Report {session_id}"
    generated = session_title(str(payload.get("transcript_path") or ""), session_id)
    if generated:
        title += f" — {generated}"
    ok, result = gh_create_issue(title[:256], body)
    if not ok:
        return f"Copy failed: {result}. Retry copy-message-as-issue."
    path.unlink(missing_ok=True)
    _remove_empty_cache_directory(payload)
    return f"Saved: {result}"


def handle_save(payload: dict) -> None:
    try:
        result = save(payload)
    except subprocess.TimeoutExpired:
        result = (
            "GitHub operation timed out; the issue may have been created. "
            "Check GitHub before retrying copy-message-as-issue."
        )
    except Exception as exc:
        result = f"Copy failed: {exc}. No model fallback was invoked."
    sys.stderr.write("\n\n" + result + "\n")
    raise SystemExit(2)


def main() -> None:
    payload = json.load(sys.stdin)
    if payload.get("agent_id"):
        return
    try:
        event = payload.get("hook_event_name")
        if event == "Stop":
            capture(payload)
        elif event in {"SessionStart", "SessionEnd", "StopFailure"}:
            invalidate(payload)
    except Exception as exc:
        sys.stderr.write(f"copy-message-as-issue response cache unavailable: {exc}\n")


if __name__ == "__main__":
    main()
