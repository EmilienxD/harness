import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from harness_cli import sessions


HOOK = Path(__file__).parents[1] / "harness/session-replies/claude/hooks/reply_delivery.py"


def setup_requests(tmp_path, monkeypatch, count=1):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config: ["claude"])
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    requests = [sessions.ask(f"request {index}") for index in range(count)]
    return parent, requests


def reply_as(monkeypatch, request, message):
    request_id, child_id = request
    monkeypatch.setenv("HARNESS_SESSION_ID", child_id)
    monkeypatch.setenv("HARNESS_REQUEST_ID", request_id)
    return sessions.reply(message)


def hook_environment(tmp_path):
    environment = os.environ.copy()
    environment["HARNESS_STATE_DIR"] = str(tmp_path)
    return environment


def run_hook(tmp_path, parent, mode):
    return subprocess.run(
        [sys.executable, str(HOOK), mode],
        input=json.dumps({"session_id": parent, "hook_event_name": "Stop"}),
        text=True,
        capture_output=True,
        env=hook_environment(tmp_path),
        timeout=5,
    )


def delivered(result):
    if not result.stdout:
        return ""
    return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]


def test_competing_delivery_hooks_atomically_claim_each_reply_once(tmp_path, monkeypatch):
    parent, requests = setup_requests(tmp_path, monkeypatch)
    delivery_id = reply_as(monkeypatch, requests[0], "finished")
    payload = json.dumps({"session_id": parent, "hook_event_name": "PostToolUse"})
    processes = [
        subprocess.Popen(
            [sys.executable, str(HOOK), "post-tool"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=hook_environment(tmp_path),
        )
        for _ in range(2)
    ]
    outputs = [process.communicate(payload, timeout=5)[0] for process in processes]
    nonempty = [output for output in outputs if output]
    assert len(nonempty) == 1
    assert delivery_id in nonempty[0]


def test_stop_wakes_for_first_reply_and_drains_only_replies_ready_then(tmp_path, monkeypatch):
    parent, requests = setup_requests(tmp_path, monkeypatch, count=2)
    process = subprocess.Popen(
        [sys.executable, str(HOOK), "stop"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=hook_environment(tmp_path),
    )
    assert process.stdin is not None
    process.stdin.write(json.dumps({"session_id": parent, "hook_event_name": "Stop"}))
    process.stdin.close()
    time.sleep(0.15)
    delivery_id = reply_as(monkeypatch, requests[1], "second answered first")
    process.wait(timeout=5)
    assert process.stdout is not None
    output = process.stdout.read()
    assert delivery_id in output
    assert "second answered first" in output
    assert requests[0][0] not in output


def test_prompt_fallback_redelivers_unacknowledged_claim_with_stable_id(tmp_path, monkeypatch):
    parent, requests = setup_requests(tmp_path, monkeypatch)
    delivery_id = reply_as(monkeypatch, requests[0], "durable answer")
    first = delivered(run_hook(tmp_path, parent, "post-tool"))
    fallback = delivered(run_hook(tmp_path, parent, "prompt"))
    assert delivery_id in first
    assert fallback == first

    connection = sqlite3.connect(tmp_path / "sessions.sqlite3")
    try:
        connection.execute(
            "UPDATE requests SET claimed_at = datetime('now', '-10 seconds') WHERE delivery_id = ?",
            (delivery_id,),
        )
        connection.commit()
    finally:
        connection.close()
    assert delivered(run_hook(tmp_path, parent, "post-tool")) == ""
    connection = sqlite3.connect(tmp_path / "sessions.sqlite3")
    try:
        acknowledged = connection.execute(
            "SELECT acknowledged_at FROM requests WHERE delivery_id = ?", (delivery_id,)
        ).fetchone()[0]
        assert acknowledged is not None
    finally:
        connection.close()


def test_post_tool_without_ready_reply_is_non_blocking(tmp_path, monkeypatch):
    parent, _requests = setup_requests(tmp_path, monkeypatch)
    started = time.monotonic()
    result = run_hook(tmp_path, parent, "post-tool")
    assert result.returncode == 0
    assert result.stdout == ""
    assert time.monotonic() - started < 1
