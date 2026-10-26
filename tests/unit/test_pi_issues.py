"""Pi adapters retain complete context and isolate native draft batches."""
import json
from pathlib import Path
import sys
import subprocess
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "harness/building/issue-readers"))
sys.path.insert(0, str(ROOT / "harness/building/issue-writers"))
import issue_readers_pi as readers
import issue_writers_pi as writers


def issue(number, **values):
    return {"number": number, "repository": "acme/demo", "state": "OPEN", "body": "",
            "parent": None, "sub_issues": [], "blocked_by": [], "blocking": [], **values}


def test_pi_reads_paginated_graph_and_follows_relations_once(monkeypatch, tmp_path):
    monkeypatch.setattr(readers.core, "address_checkout_context", lambda *args: "")
    monkeypatch.setattr(readers.core, "current_repository", lambda *args: "acme/demo")
    monkeypatch.setenv("HARNESS_ISSUE_CONTEXT_DEPTH", "1")
    calls = []
    def get(repo, number, cwd):
        calls.append((repo, number))
        return issue(number, parent={"number": 2, "repository": {"nameWithOwner": repo}},
                     blocked_by=[{"number": 2, "repository": {"nameWithOwner": repo}}],
                     comments=[{"body": str(i)} for i in range(150)])
    monkeypatch.setattr(readers.graph, "get_issue", get)
    documents = json.loads(readers.prepare("address-this", "1", tmp_path).split(":\n", 1)[1])
    assert len(documents[0]["comments"]) == 150
    assert calls == [("acme/demo", 1), ("acme/demo", 2)]


@pytest.mark.parametrize("skill", ["address-this", "review-this"])
def test_pi_link_label_never_fetches_an_unrelated_local_issue(monkeypatch, tmp_path, skill):
    monkeypatch.setattr(readers.core, "address_checkout_context", lambda *args: "")
    monkeypatch.setattr(readers.core, "build_review_context", lambda *args: "")
    monkeypatch.setenv("HARNESS_ISSUE_CONTEXT_DEPTH", "1")
    body = "See [security fix #3186](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/3186). Related to #9."
    calls = []

    def get(repo, number, cwd):
        calls.append((repo, number))
        assert number in {491, 9}
        return issue(number, body=body if number == 491 else "")

    monkeypatch.setattr(readers.graph, "get_issue", get)
    readers.prepare(skill, "https://github.com/acme/demo/issues/491", tmp_path)
    assert calls == [("acme/demo", 491), ("acme/demo", 9)]


@pytest.mark.parametrize("skill", ["address-this", "review-this"])
@pytest.mark.parametrize("primary", [491, 99])
def test_pi_skips_missing_related_issues_but_blocks_missing_primary(monkeypatch, tmp_path, skill, primary):
    monkeypatch.setattr(readers.core, "address_checkout_context", lambda *args: "")
    monkeypatch.setattr(readers.core, "build_review_context", lambda *args: "")
    monkeypatch.setenv("HARNESS_ISSUE_CONTEXT_DEPTH", "1")
    calls = []

    def run(command, **kwargs):
        number = int(next(value.split("=", 1)[1] for value in command if value.startswith("number=")))
        calls.append(number)
        if number == 99:
            payload = {"data": {"repository": {"issue": None}}, "errors": [
                {"type": "NOT_FOUND", "path": ["repository", "issue"], "message": "Missing issue"},
            ]}
            return subprocess.CompletedProcess(command, 1, json.dumps(payload), "gh: Missing issue")
        document = issue(number, body="See #99, then #9, and #99 again." if number == 491 else "")
        return subprocess.CompletedProcess(command, 0, json.dumps({"data": {"repository": {"issue": document}}}), "")

    monkeypatch.setattr(subprocess, "run", run)
    if primary == 99:
        with pytest.raises(readers.core.Blocked):
            readers.prepare(skill, f"https://github.com/acme/demo/issues/{primary}", tmp_path)
        assert calls == [99]
    else:
        documents = json.loads(readers.prepare(skill, f"https://github.com/acme/demo/issues/{primary}", tmp_path).split(":\n", 1)[1])
        assert [document["number"] for document in documents] == [491, 9]
        assert calls == [491, 99, 9]


def test_closed_issue_stops_address_preparation(monkeypatch, tmp_path):
    monkeypatch.setattr(readers.core, "address_checkout_context", lambda *args: "")
    monkeypatch.setattr(readers.graph, "get_issue", lambda *args: issue(1, state="CLOSED"))
    with pytest.raises(readers.core.Blocked):
        readers.prepare("address-this", "https://github.com/acme/demo/issues/1", tmp_path)


def test_literal_address_has_no_github_lookup(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(readers.core, "build_address_context", lambda text, cwd: calls.append(text) or "")
    monkeypatch.setattr(readers.graph, "get_issue", lambda *args: pytest.fail("Literal text fetched GitHub"))
    readers.prepare("address-this", "fix the bug mentioned in #1", tmp_path)
    assert calls == ["fix the bug mentioned in #1"]


def test_pi_identity_is_namespaced_and_reproducible():
    native = str(uuid.uuid4())
    session = writers.issues_session_id(native)
    assert uuid.UUID(session).version == 5
    assert session == writers.issues_session_id(native)
    assert session != native
    assert session != str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:chatgpt:{native}"))
    assert session != writers.issues_session_id(str(uuid.uuid4()))
    with pytest.raises(ValueError):
        writers.issues_session_id("")


@pytest.mark.parametrize("skill", ["draft-issue", "draft-issues", "to-spec", "to-spec-draft-issue"])
def test_all_drafting_skills_prepare_native_session_store(monkeypatch, tmp_path, skill):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    session = writers.issues_session_id("native-id")
    request = {"version": 1, "cwd": str(tmp_path), "sessionId": "native-id", "operation": "prepare", "skill": skill}
    assert writers.evaluate(request)["ok"]
    drafts = tmp_path / writers.core.DRAFTS_DIR
    assert (drafts / ".gitignore").read_text() == "*\n"
    (drafts / writers.core.draft_name(session, 0)).write_text("# Draft\n")
    next_path = writers.core.next_draft_path(tmp_path, session)
    assert next_path.name == writers.core.draft_name(session, 1)


def test_notice_consumed_by_same_pi_session_only(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    session = writers.issues_session_id("one")
    writers.core.queue_notice(tmp_path, session, [], 1)
    request = {"version": 1, "cwd": str(tmp_path), "operation": "notice", "sessionId": "two"}
    assert not writers.evaluate(request)["message"]
    request["sessionId"] = "one"
    assert writers.evaluate(request)["message"]
    assert not writers.evaluate(request)["message"]


def test_publish_unknown_arguments_never_mutates(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(writers.core, "publish_issues", lambda *args: pytest.fail("Invalid command published"))
    assert writers.evaluate({"version": 1, "cwd": str(tmp_path), "sessionId": "native", "operation": "publish", "argument": "--unknown"})["ok"]
