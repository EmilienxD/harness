"""Exercise response capture and publication without contacting GitHub."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SHARED = ROOT / "harness/building/issue-writers"
sys.path.insert(0, str(SHARED))
import copy_message_as_issue as hook

SID = "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55"


@pytest.fixture
def payload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_COPY_MESSAGE_CACHE_DIR", str(tmp_path / "provider-cache"))
    return {"session_id": SID, "cwd": str(tmp_path), "prompt": "/copy-message-as-issue",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "last_assistant_message": "# Report\n\n> spec\n\n## Parent\n#42\n\n" + SID + "/0\n"}


@pytest.fixture
def remote(monkeypatch):
    calls = []

    def create(title, body):
        calls.append((title, body, [], None))
        return True, "https://github.com/owner/repo/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", create)
    return calls


def write_titles(payload):
    records = [
        {"type": "ai-title", "aiTitle": "Old", "sessionId": SID},
        {"type": "custom-title", "customTitle": "Manual", "sessionId": SID},
        {"type": "ai-title", "aiTitle": "Latest\n title", "sessionId": SID},
        {"type": "ai-title", "aiTitle": "Other session", "sessionId": "other"},
        {"type": "ai-title", "aiTitle": " ", "sessionId": SID},
        [],
    ]
    Path(payload["transcript_path"]).write_text(
        "\n".join(json.dumps(r) for r in records) + '\n{"partial":', encoding="utf-8")


def test_title_reads_last_matching_ai_record(payload):
    write_titles(payload)
    assert hook.session_title(payload["transcript_path"], SID) == "Latest title"
    assert hook.session_title("missing.jsonl", SID) == ""


def test_save_posts_the_latest_response_directly_and_consumes_it(payload, remote):
    write_titles(payload)
    hook.capture(payload)
    assert "Saved:" in hook.save(payload)
    assert "No completed response" in hook.save(payload)
    assert len(remote) == 1
    title, body, labels, parent = remote[0]
    assert title == f"Report {SID} — Latest title"
    assert body == payload["last_assistant_message"]
    assert labels == [] and parent is None
    assert not hook.cache_path(payload).exists()
    assert not (Path(payload["cwd"]) / ".issues-gateway").exists()


def test_identical_responses_from_distinct_turns_can_each_be_copied(payload, remote):
    hook.capture(payload)
    hook.save(payload)
    hook.invalidate(payload)
    # An identical response in a different completed turn can be saved separately.
    hook.capture(payload)
    hook.save(payload)
    assert len(remote) == 2
    assert remote[0][0] == f"Report {SID}"
    assert remote[0][1] == remote[1][1] == payload["last_assistant_message"]


def test_capture_ignores_subagents_and_clears_empty_response(payload):
    hook.capture({**payload, "agent_id": "child"})
    assert not hook.cache_path(payload).exists()
    hook.capture(payload)
    hook.capture({**payload, "last_assistant_message": ""})
    assert not hook.cache_path(payload).exists()


def test_repeated_stop_keeps_identity(payload):
    hook.capture(payload)
    before = hook.cache_path(payload).read_bytes()
    hook.capture(payload)
    assert hook.cache_path(payload).read_bytes() == before


def test_response_cache_is_not_part_of_the_issues_gateway(payload, monkeypatch, tmp_path):
    cache_root = tmp_path / "provider-cache"
    monkeypatch.setenv("HARNESS_COPY_MESSAGE_CACHE_DIR", str(cache_root))

    hook.capture(payload)

    assert hook.cache_path(payload).is_relative_to(cache_root)
    assert not (tmp_path / ".issues-gateway").exists()


def test_abandoned_response_cache_expires(payload):
    hook.capture(payload)
    cached = hook.cache_path(payload)
    os.utime(cached, (0, 0))

    hook.sweep(payload, now=hook.CACHE_MAX_AGE_SECONDS + 1)

    assert not cached.exists()


def test_sweep_expires_abandoned_cache_from_an_inactive_workspace(
    payload, tmp_path
):
    other = {**payload, "cwd": str(tmp_path / "other-workspace")}
    hook.capture(other)
    abandoned = hook.cache_path(other)
    os.utime(abandoned, (0, 0))

    hook.sweep(payload, now=hook.CACHE_MAX_AGE_SECONDS + 1)

    assert not abandoned.exists()


def test_missing_cache_and_malformed_invocation_do_not_publish(payload, remote):
    assert "No completed response" in hook.save(payload)
    hook.capture(payload)
    assert "Usage:" in hook.save({**payload, "prompt": "use/copy-message-as-issue"})
    assert remote == []


def test_failed_copy_keeps_the_response_for_a_retry(payload, remote, monkeypatch):
    hook.capture(payload)
    monkeypatch.setattr(hook, "gh_create_issue", lambda *a: (False, "offline"))
    assert "Copy failed" in hook.save(payload)
    assert hook.cache_path(payload).exists()
    monkeypatch.setattr(
        hook,
        "gh_create_issue",
        lambda title, body: (remote.append((title, body, [], None)) or True, "https://github.com/owner/repo/issues/42"),
    )
    assert "Saved:" in hook.save(payload)
    assert len(remote) == 1
    assert not hook.cache_path(payload).exists()


def test_timeout_reports_failure_and_keeps_the_response(payload, monkeypatch, capsys):
    hook.capture(payload)

    def timeout(*args):
        raise subprocess.TimeoutExpired("gh", 30)

    monkeypatch.setattr(hook, "gh_create_issue", timeout)
    with pytest.raises(SystemExit) as stopped:
        hook.handle_save(payload)
    assert stopped.value.code == 2
    assert "timed out" in capsys.readouterr().err
    assert hook.cache_path(payload).exists()


def run_adapter(payload):
    env = {**os.environ, "PYTHONPATH": str(SHARED)}
    return subprocess.run([sys.executable, str(SHARED / "issue_writers_hook.py"), "--claude"],
                          input=json.dumps(payload), text=True, capture_output=True, env=env)


@pytest.mark.parametrize("event", ["SessionStart", "SessionEnd", "StopFailure"])
def test_lifecycle_invalidates_cache(payload, event):
    hook.capture(payload)
    result = run_adapter({**payload, "hook_event_name": event})
    assert result.returncode == 0 and not result.stdout
    assert not hook.cache_path(payload).exists()


def test_prompt_dispatch_blocks_save_and_invalidates_on_regular_prompt(payload):
    result = run_adapter(payload)
    assert result.returncode == 2 and "No completed response" in result.stderr
    assert not result.stdout
    hook.capture(payload)
    result = run_adapter({**payload, "prompt": "Continue"})
    assert result.returncode == 0
    assert not hook.cache_path(payload).exists()


def test_stop_adapter_captures_without_model_output(payload):
    result = run_adapter({**payload, "hook_event_name": "Stop"})
    assert result.returncode == 0 and not result.stdout
    assert json.loads(hook.cache_path(payload).read_text())["body"] == payload["last_assistant_message"]


def test_github_receives_the_response_through_a_temporary_body_file(monkeypatch):
    call = {}

    def run(args, **kwargs):
        call.update(args=args, kwargs=kwargs, body=Path(args[-1]).read_text(encoding="utf-8"))
        return subprocess.CompletedProcess(args, 0, "https://github.com/o/r/issues/9\n", "")

    monkeypatch.setattr(hook.subprocess, "run", run)

    assert hook.gh_create_issue("Report", "the complete response") == (
        True,
        "https://github.com/o/r/issues/9",
    )
    assert call["args"][:5] == ["gh", "issue", "create", "--title", "Report"]
    assert call["body"] == "the complete response"
    assert call["kwargs"]["timeout"] == 240
    assert not Path(call["args"][-1]).exists()
