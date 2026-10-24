"""Fail-closed /auto bridge command owned by Harness."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request


COMMAND = re.compile(r"^\s*(?:/auto|\$auto|\[\$auto\]\([^\r\n]+\))(?P<arguments>\s[\s\S]*)?$")


def deny(message: str) -> int:
    if "--chatgpt" in sys.argv[1:]:
        print(json.dumps({"decision": "block", "reason": message}))
        return 0
    sys.stderr.write("\n\n" + message)
    return 2


def main() -> int:
    try:
        return handle_prompt()
    except Exception as error:
        return deny(f"Aboard could not handle /auto ({type(error).__name__}): {error}")


def handle_prompt() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("hook input must be a JSON object")
    prompt = payload.get("prompt")
    match = COMMAND.fullmatch(prompt) if isinstance(prompt, str) else None
    if match is None:
        return 0
    prompt = "/auto" + (match.group("arguments") or "")
    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
    except (KeyError, ValueError):
        return deny("/auto requires an active Aboard session. Start this agent from the Aboard panel.")
    runtime_session_id = payload.get("session_id")
    session_id = runtime_session_id if isinstance(runtime_session_id, str) and runtime_session_id else os.environ.get("ABOARD_SESSION_ID")
    if not session_id:
        return deny("/auto requires an active Aboard session. Start this agent from the Aboard panel.")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/hooks/auto",
        data=json.dumps({"sessionId": session_id, "prompt": prompt}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=115) as response:
            result = json.load(response)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as exc:
        return deny(f"Aboard could not handle /auto: {exc}")
    return deny(str(result.get("message") or "Aboard handled /auto."))


if __name__ == "__main__":
    raise SystemExit(main())
