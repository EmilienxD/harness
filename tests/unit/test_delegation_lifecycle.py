from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from subagents_runtime import sessions
from subagents_runtime.delegation import (
    arm_reply,
    clear_reply_authorization,
    claim_parent_delivery,
    observe_parent_event,
    open_grant,
    process_grant,
    report_child_stop,
)


def setup_request(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str = "auto") -> tuple[str, str, str]:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider="claude": ["claude"])
    parent = sessions.launch(provider="claude", cwd=tmp_path)
    grant = open_grant(parent, "ask-agent", original_cwd=tmp_path)
    request_file = grant.inbox / "request.md"
    request_file.write_text(f"---\ntask: general\nmode: {mode}\n---\n\nDo the work.\n", encoding="utf-8")
    [result] = process_grant(grant.id, launch=lambda _request, _request_id, _number, _cwd: "child")
    assert result.request_id and result.child_session_id
    return parent, result.request_id, result.child_session_id


def test_auto_stop_resolves_once_and_formats_a_stable_agent_number(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, request, child = setup_request(tmp_path, monkeypatch)

    assert report_child_stop(child, "Finished safely.", success=True) is True
    assert report_child_stop(child, "Different replay.", success=True) is False
    delivery = claim_parent_delivery(parent, "PostToolUse")

    assert delivery is not None
    assert delivery.text == "Agent 1 finished. Agent replied:\n\nFinished safely.\n\n0 agents still running."
    replay = claim_parent_delivery(parent, "PostToolUse")
    assert replay is not None and replay.delivery_id == delivery.delivery_id


def test_interactive_stop_requires_one_shot_reply_authorization(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, request, child = setup_request(tmp_path, monkeypatch, mode="interactive")

    assert report_child_stop(child, "Not armed.", success=True) is False
    arm_reply(child)
    with pytest.raises(sessions.SessionError, match="already armed"):
        arm_reply(child)
    assert report_child_stop(child, "The routed answer.", success=True) is True
    assert report_child_stop(child, "Second answer.", success=True) is False
    with pytest.raises(sessions.SessionError, match="pending interactive"):
        arm_reply(child)

    delivery = claim_parent_delivery(parent, "UserPromptSubmit")
    assert delivery is not None and "The routed answer." in delivery.text


def test_failed_interactive_stop_clears_authorization_but_keeps_request_pending(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _parent, request, child = setup_request(tmp_path, monkeypatch, mode="interactive")
    arm_reply(child)

    assert report_child_stop(child, "API failed", success=False, reason="API failure") is False
    arm_reply(child)

    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT state FROM requests WHERE id = ?", (request,)).fetchone()[0] == "pending"
    finally:
        connection.close()


def test_interrupted_interactive_turn_clears_one_shot_reply_authorization(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _parent, _request, child = setup_request(tmp_path, monkeypatch, mode="interactive")
    arm_reply(child)

    assert clear_reply_authorization(child) is True
    assert clear_reply_authorization(child) is False
    arm_reply(child)


def test_interactive_session_termination_cancels_without_reply_authorization(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, _request, child = setup_request(tmp_path, monkeypatch, mode="interactive")

    assert report_child_stop(child, "", success=False, reason="session ended", cancelled=True) is True
    delivery = claim_parent_delivery(parent, "UserPromptSubmit")

    assert delivery is not None
    assert delivery.text == "Agent 1 was cancelled.\n\n0 agents still running."


def test_delivery_acknowledges_only_after_a_later_observed_parent_event(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, request, child = setup_request(tmp_path, monkeypatch)
    report_child_stop(child, "Durable.", success=True)

    first = claim_parent_delivery(parent, "PostToolUse")
    replay = claim_parent_delivery(parent, "UserPromptSubmit")
    assert first is not None and replay is not None
    assert replay.delivery_id == first.delivery_id
    assert replay.text == first.text

    observe_parent_event(parent, "PreToolUse")
    assert claim_parent_delivery(parent, "PostToolUse") is None

    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        claim, acknowledgement = connection.execute(
            "SELECT claim_sequence, acknowledgement_sequence FROM requests WHERE id = ?", (request,)
        ).fetchone()
        assert acknowledgement > claim
    finally:
        connection.close()


def test_failures_are_deferred_and_do_not_wake_stop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, _request, child = setup_request(tmp_path, monkeypatch)
    assert report_child_stop(child, "", success=False, reason="terminal exited") is True

    assert claim_parent_delivery(parent, "Stop") is None
    delivery = claim_parent_delivery(parent, "UserPromptSubmit")
    assert delivery is not None
    assert delivery.text == "Agent 1 failed: terminal exited.\n\n0 agents still running."


def test_unattended_children_cannot_open_delegation_grants_but_interactive_children_can(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _parent, _request, auto_child = setup_request(tmp_path, monkeypatch, mode="auto")
    with pytest.raises(sessions.SessionError, match="cannot delegate"):
        open_grant(auto_child, "ask-agent", original_cwd=tmp_path)

    auto_run_child = "auto-run-child"
    sessions._register(auto_run_child, tmp_path, "claude", "auto-run")
    with pytest.raises(sessions.SessionError, match="cannot delegate"):
        open_grant(auto_run_child, "ask-agent", original_cwd=tmp_path)

    _parent, _request, interactive_child = setup_request(tmp_path / "interactive", monkeypatch, mode="interactive")
    grant = open_grant(interactive_child, "ask-agent", original_cwd=tmp_path / "interactive")
    assert grant.parent_session_id == interactive_child


def test_existing_session_database_migrates_without_losing_a_ready_reply(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = tmp_path / "state"
    state.mkdir()
    database = state / "sessions.sqlite3"
    connection = sqlite3.connect(database)
    connection.executescript("""
        CREATE TABLE sessions (id TEXT PRIMARY KEY, claude_session_id TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE requests (
            id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id),
            child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
            state TEXT NOT NULL CHECK(state IN ('pending', 'replied')), reply TEXT,
            delivery_id TEXT UNIQUE, claimed_at TEXT, acknowledged_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO sessions(id, claude_session_id, cwd) VALUES ('parent', 'parent', 'C:/work'), ('child', 'child', 'C:/work');
        INSERT INTO requests(id, parent_session_id, child_session_id, state, reply, delivery_id)
        VALUES ('request', 'parent', 'child', 'replied', 'legacy answer', 'delivery');
    """)
    connection.commit()
    connection.close()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))

    delivery = claim_parent_delivery("parent", "UserPromptSubmit")

    assert delivery is not None and "legacy answer" in delivery.text
    connection = sqlite3.connect(database)
    try:
        assert connection.execute("SELECT provider, execution_mode FROM sessions WHERE id = 'parent'").fetchone() == ("claude", "interactive")
    finally:
        connection.close()
