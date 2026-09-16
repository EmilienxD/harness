"""Provider hook that binds CLI receipts to agent sessions."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from report_gotchas.reports import ReportError, finalize
from report_gotchas.config import webhook_url


RECEIPT = re.compile(r"HARNESS_REPORT_GOTCHAS_RECEIPT:([0-9a-f]{32})")

def provider_from_argv(argv: list[str]) -> str | None:
    """The provider the installer wired this hook into, or None if it didn't say."""
    for token in argv:
        if token == "--claude":
            return "claude"
        if token == "--chatgpt":
            return "chatgpt"
    return None


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def _context(event: str, message: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}}


def _launch_worker(receipt: str) -> None:
    if webhook_url() is None:
        return
    flags = 0
    if os.name == "nt":
        # DETACHED_PROCESS makes Windows ignore CREATE_NO_WINDOW, allowing
        # Python's launcher to allocate a visible console for its child.
        flags = subprocess.CREATE_NO_WINDOW
    subprocess.Popen(
        [sys.executable, "-m", "report_gotchas.cli", "deliver", receipt],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=os.name != "nt",
        creationflags=flags,
    )


def handle(
    payload: dict[str, Any],
    provider: str = "claude",
    *,
    launch_worker: Callable[[str], None] | None = None,
) -> dict[str, Any] | None:
    event = str(payload.get("hook_event_name", ""))
    if event != "PostToolUse" or payload.get("tool_name") not in {"Bash", "PowerShell"}:
        return None
    command = payload.get("tool_input", {}).get("command")
    if not isinstance(command, str) or not re.search(r"\bharness-report-gotchas(?:\.exe)?\s+submit\b", command):
        return None
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return None
    receipts = {
        match.group(1)
        for text in _strings(payload.get("tool_response"))
        for match in RECEIPT.finditer(text)
    }
    if not receipts:
        return None
    processed = 0
    for receipt in sorted(receipts):
        try:
            finalize(receipt, session_id, Path(payload.get("cwd") or Path.cwd()), provider)
        except ReportError:
            continue
        (launch_worker or _launch_worker)(receipt)
        processed += 1
    if not processed:
        return None
    noun = "report" if processed == 1 else "reports"
    suffix = "" if webhook_url() is not None else " Configure the Discord webhook to deliver it."
    return _context(event, f"Gotcha {noun} queued for Discord delivery.{suffix}")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        provider = provider_from_argv(sys.argv[1:]) or "claude"
        output = handle(payload, provider)
        if output is not None:
            print(json.dumps(output))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
