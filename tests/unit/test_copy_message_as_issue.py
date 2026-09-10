"""Exercise response capture and publication without contacting GitHub."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]
SHARED = ROOT / "harness/building/issues/shared/hooks"
CLAUDE = ROOT / "harness/building/issues/claude/hooks"
sys.path.insert(0, str(SHARED))
sys.path.insert(0, str(CLAUDE))
import issues_core as core
import copy_message_as_issue as hook

SID = "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55"


@pytest.fixture
def payload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return {"session_id": SID, "cwd": str(tmp_path), "prompt": "/copy-message-as-issue",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "last_assistant_message": "# Report\n\n> spec\n\n## Parent\n#42\n\n" + SID + "/0\n"}


@pytest.fixture
def remote(monkeypatch):
    calls = []
    monkeypatch.setattr(core, "gh_repository", lambda: (True, "owner/repo"))
    monkeypatch.setattr(core, "gh_find_reserved_issue", lambda *a: (True, None))
    monkeypatch.setattr(core, "gh_existing_comment_parts", lambda *a: (True, set()))

    def create(title, body, labels, parent):
        calls.append((title, body, labels, parent))
        return True, "https://github.com/owner/repo/issues/42"

    monkeypatch.setattr(core, "gh_create_issue", create)
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


def test_save_preserves_body_and_deduplicates(payload, remote):
    write_titles(payload)
    hook.capture(payload)
    assert "Saved:" in hook.save(payload)
    assert "Already saved:" in hook.save(payload)
    assert len(remote) == 1
    title, body, labels, parent = remote[0]
    assert title == f"Report {SID} — Latest title"
    assert body.startswith(payload["last_assistant_message"])
    assert "<!-- issues-gateway:" in body
    assert labels == [] and parent is None


def test_fallback_and_distinct_response_identity(payload, remote):
    hook.capture(payload)
    hook.save(payload)
    hook.invalidate(payload)
    # An identical response in a different completed turn can be saved separately.
    hook.capture(payload)
    hook.save(payload)
    assert len(remote) == 2
    assert remote[0][0] == f"Report {SID}"
    assert remote[0][1] != remote[1][1]  # distinct recovery markers


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


def test_missing_cache_and_arguments_do_not_publish(payload, remote):
    assert "No completed response" in hook.save(payload)
    hook.capture(payload)
    assert "Usage:" in hook.save({**payload, "prompt": "/copy-message-as-issue extra"})
    assert remote == []


def test_partial_continuation_resumes_with_original_title(payload, remote, monkeypatch):
    payload["last_assistant_message"] = "Long report\n\n" * 6000
    hook.capture(payload)
    monkeypatch.setattr(core, "gh_comment_issue", lambda *a: (False, "offline"))
    assert "Copy failed" in hook.save(payload)
    write_titles(payload)
    comments = []
    monkeypatch.setattr(core, "gh_comment_issue", lambda *a: (comments.append(a) or True, ""))
    assert "Saved:" in hook.save(payload)
    assert len(remote) == 1
    assert remote[0][0] == f"Report {SID}"
    assert comments
    assert "Already saved:" in hook.save(payload)


def test_unknown_create_outcome_never_creates_again(payload, remote, monkeypatch):
    hook.capture(payload)

    def timeout(*args):
        raise subprocess.TimeoutExpired("gh", 30)

    monkeypatch.setattr(core, "gh_create_issue", timeout)
    with pytest.raises(SystemExit) as stopped:
        hook.handle_save(payload)
    assert stopped.value.code == 2
    monkeypatch.setattr(core, "gh_create_issue", lambda *a: pytest.fail("duplicate create"))
    assert "refusing another create" in hook.save(payload)


def test_publication_lock_prevents_overlap(payload, remote):
    hook.capture(payload)
    with core.file_lock(hook.cache_path(payload).with_suffix(".lock")) as acquired:
        assert acquired
        assert "already saving" in hook.save(payload)
    assert remote == []


def run_adapter(payload, filename):
    env = {**os.environ, "PYTHONPATH": os.pathsep.join((str(SHARED), str(CLAUDE)))}
    return subprocess.run([sys.executable, str(CLAUDE / filename)],
                          input=json.dumps(payload), text=True, capture_output=True, env=env)


@pytest.mark.parametrize("event", ["SessionStart", "StopFailure"])
def test_lifecycle_invalidates_cache(payload, event):
    hook.capture(payload)
    result = run_adapter({**payload, "hook_event_name": event}, "copy_message_as_issue.py")
    assert result.returncode == 0 and not result.stdout
    assert not hook.cache_path(payload).exists()


def test_prompt_dispatch_blocks_save_and_invalidates_on_regular_prompt(payload):
    result = run_adapter(payload, "publish_issues_UserPromptSubmit_hook.py")
    assert result.returncode == 2 and "No completed response" in result.stderr
    assert not result.stdout
    hook.capture(payload)
    result = run_adapter({**payload, "prompt": "Continue"}, "publish_issues_UserPromptSubmit_hook.py")
    assert result.returncode == 0
    assert not hook.cache_path(payload).exists()


def test_stop_adapter_captures_without_model_output(payload):
    result = run_adapter({**payload, "hook_event_name": "Stop"}, "copy_message_as_issue.py")
    assert result.returncode == 0 and not result.stdout
    assert json.loads(hook.cache_path(payload).read_text())["body"] == payload["last_assistant_message"]


def test_github_deadline_bounds_processes(monkeypatch):
    calls = []
    monkeypatch.setattr(core.subprocess, "run", lambda *a, **kw: calls.append(kw))
    token = core.GH_DEADLINE.set(time.monotonic() + 5)
    try:
        core.run_gh(["gh"])
        assert 0 < calls[0]["timeout"] <= 5
        core.GH_DEADLINE.set(time.monotonic() - 1)
        with pytest.raises(subprocess.TimeoutExpired):
            core.run_gh(["gh"])
        assert len(calls) == 1
    finally:
        core.GH_DEADLINE.reset(token)
