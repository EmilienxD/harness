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
    enable_delegation,
    process_inbox,
    report_child_stop,
)


def test_stop_wait_rechecks_delivery_when_the_last_child_settles(monkeypatch):
    from subagents_runtime import delegation

    delivery = delegation.ParentDelivery("fixture-delivery", "fixture result")
    settled = False

    def claim(*args):
        return delivery if settled else None

    def pending(*args):
        nonlocal settled
        settled = True
        return False

    monkeypatch.setattr(delegation, "claim_parent_delivery", claim)
    monkeypatch.setattr(delegation, "has_pending_children", pending)
    assert delegation.wait_parent_delivery("parent", timeout_seconds=1) is delivery


def setup_request(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str = "auto") -> tuple[str, str, str]:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider="claude": ["claude"])
    from subagents_runtime import processes
    monkeypatch.setattr(processes,"start",lambda execution_id,*args,**kwargs: processes.confirm_startup(execution_id))
    parent = sessions.launch(provider="claude", cwd=tmp_path)
    grant = enable_delegation(parent, "subagents-toolkit", original_cwd=tmp_path)
    request_file = grant.inbox / "request.md"
    request_file.write_text(f"---\nmode: {mode}\n---\n\nDo the work.\n", encoding="utf-8")
    [result] = process_inbox(grant.id, launch=lambda _request, _request_id, _number, _cwd: "child")
    assert result.request_id and result.child_session_id
    return parent, result.request_id, result.child_session_id


def test_auto_stop_resolves_once_and_formats_a_stable_agent_number(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, request, child = setup_request(tmp_path, monkeypatch)

    assert report_child_stop(child, "Finished safely.", success=True) is True
    assert report_child_stop(child, "Different replay.", success=True) is False
    delivery = claim_parent_delivery(parent, "PostToolUse")

    assert delivery is not None
    assert delivery.delivery_id and "Finished safely." in delivery.text
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


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("nested_result", [False, True])
def test_reply_hook_arms_silently_and_preserves_nested_result_delivery(tmp_path, monkeypatch, provider, nested_result):
    from subagents_runtime.hooks import handle

    parent, request, child = setup_request(tmp_path, monkeypatch, mode="interactive")
    with sessions._connect() as connection:
        connection.execute("UPDATE sessions SET provider=? WHERE id=?", (provider, child))
    if nested_result:
        inbox = enable_delegation(child, "subagents-toolkit").inbox
        (inbox / "nested.md").write_text("---\nmode: auto\n---\nInspect the configuration.", encoding="utf-8")
        [nested] = process_inbox(child, launch=lambda *_args: "nested-conversation")
        assert report_child_stop(nested.child_session_id, "Configuration inspected.", success=True)

    output = handle({
        "session_id": child, "cwd": str(tmp_path), "hook_event_name": "UserPromptSubmit",
        "prompt": ("/" if provider == "claude" else "$") + "reply-to-agent",
    }, provider)

    if nested_result:
        delivery = claim_parent_delivery(child, "UserPromptSubmit")
        assert delivery is not None
        assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
        observe_parent_event(child, "PreToolUse")
        assert claim_parent_delivery(child, "PostToolUse") is None
    else:
        assert output is None
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT request_id FROM reply_authorizations WHERE child_session_id=?", (child,),
        ).fetchone() == (request,)
    assert report_child_stop(child, "Finished.", success=True)
    assert claim_parent_delivery(parent, "PostToolUse") is not None


def test_successful_interactive_reply_offers_parent_terminal_link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from subagents_runtime.hooks import handle

    _parent, _request, child = setup_request(tmp_path, monkeypatch, mode="interactive")
    arm_reply(child)
    monkeypatch.setenv("HARNESS_EXECUTION_MODE", "interactive")
    monkeypatch.setenv(
        "HARNESS_PARENT_TERMINAL_URI",
        "vscode://aboard.aboard/focus-parent?childSessionId=child",
    )

    response = handle({
        "session_id": child,
        "cwd": str(tmp_path),
        "hook_event_name": "Stop",
        "last_assistant_message": "The routed answer.",
    })

    assert response == {
        "systemMessage": (
            "Reply sent to the parent. Return to the main agent: "
            "vscode://aboard.aboard/focus-parent?childSessionId=child"
        )
    }


def test_delivery_counts_running_auto_owed_replies_and_idle_children(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    for name, mode in (("a.md", "auto"), ("b.md", "auto"), ("c.md", "interactive"), ("d.md", "interactive")):
        (inbox / name).write_text(f"---\nmode: {mode}\n---\nTask.", encoding="utf-8")
    children = {
        result.request_id: result.child_session_id
        for result in process_inbox("parent", launch=lambda _request, _id, number, _cwd: f"conversation-{number}")
    }
    finished = [sessions.resolve_session(name, "parent") for name in ("agent-1", "agent-3")]
    arm_reply(finished[1])
    for child in finished:
        report_child_stop(child, "Done.", success=True)

    # A child that never bound a conversation cannot be resumed, so it is not offered.
    def unlaunchable(*_args):
        raise RuntimeError("startup failed")

    (inbox / "e.md").write_text("---\nmode: auto\n---\nTask.", encoding="utf-8")
    [stranded] = process_inbox("parent", launch=unlaunchable)
    assert stranded.status == "failed"

    delivery = claim_parent_delivery("parent", "Stop")

    assert delivery is not None and len(children) == 4
    assert delivery.text.endswith(
        "1 auto agent is still running, 1 interactive agent still owes a reply, "
        "2 agents are idle and available for resume."
    )


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
    replay = claim_parent_delivery(parent, "SessionStart")
    assert replay is not None and replay.delivery_id == delivery.delivery_id


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("backend", ["standalone", "aboard"])
@pytest.mark.parametrize("success", [True, False])
def test_auto_session_end_defers_to_its_supervisor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: str,
    backend: str, success: bool,
) -> None:
    from subagents_runtime.hooks import handle

    parent, request, child = setup_request(tmp_path, monkeypatch)
    with sessions._connect() as connection:
        execution_id = connection.execute(
            "SELECT id FROM executions WHERE session_id=? AND request_id=?", (child, request),
        ).fetchone()[0]
        connection.execute("UPDATE executions SET backend=?,state='running' WHERE id=?", (backend, execution_id))
    monkeypatch.setenv("HARNESS_EXECUTION_ID", execution_id)
    # The durable request, not an inherited/default execution-mode variable, owns the mode.
    monkeypatch.delenv("HARNESS_EXECUTION_MODE", raising=False)
    payload = {"session_id": child, "cwd": str(tmp_path), "hook_event_name": "SessionEnd", "reason": "other"}

    handle(payload, provider=provider)

    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT state,reply,delivery_id FROM requests WHERE id=?", (request,),
        ).fetchone() == ("pending", None, None)
    assert claim_parent_delivery(parent, "Stop") is None
    assert report_child_stop(
        child, "Native final answer." if success else "", success=success,
        reason=None if success else "Provider exited with code 1", execution_id=execution_id,
    ) is True
    handle(payload, provider=provider)
    expected = ("succeeded", "Native final answer.") if success else ("failed", None)
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT state,reply FROM requests WHERE id=?", (request,),
        ).fetchone() == expected
    assert claim_parent_delivery(parent, "Stop") is not None


@pytest.mark.parametrize("mode,supervised", [("auto", False), ("interactive", False), ("interactive", True)])
def test_session_end_still_cancels_children_without_an_auto_supervisor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, supervised: bool,
) -> None:
    from subagents_runtime.hooks import handle

    _parent, request, child = setup_request(tmp_path, monkeypatch, mode=mode)
    if supervised:
        with sessions._connect() as connection:
            execution_id = connection.execute(
                "SELECT id FROM executions WHERE session_id=? AND request_id=?", (child, request),
            ).fetchone()[0]
        monkeypatch.setenv("HARNESS_EXECUTION_ID", execution_id)
    else:
        monkeypatch.delenv("HARNESS_EXECUTION_ID", raising=False)

    handle({"session_id": child, "cwd": str(tmp_path), "hook_event_name": "SessionEnd", "reason": "other"})

    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT state,reply FROM requests WHERE id=?", (request,),
        ).fetchone() == ("cancelled", None)


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


def test_failures_use_the_same_durable_delivery_as_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent, _request, child = setup_request(tmp_path, monkeypatch)
    assert report_child_stop(child, "", success=False, reason="terminal exited") is True

    assert claim_parent_delivery(parent, "Stop") is not None
    delivery = claim_parent_delivery(parent, "UserPromptSubmit")
    assert delivery is not None
    assert delivery.delivery_id and "terminal exited" in delivery.text


def test_all_execution_modes_can_enable_delegation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _parent, _request, auto_child = setup_request(tmp_path, monkeypatch, mode="auto")
    assert enable_delegation(auto_child,"subagents-toolkit").inbox.is_dir()

    auto_run_child = "auto-run-child"
    sessions._register(auto_run_child, tmp_path, "claude", "auto-run")
    assert enable_delegation(auto_run_child,"subagents-toolkit").inbox.is_dir()

    _parent, _request, interactive_child = setup_request(tmp_path / "interactive", monkeypatch, mode="interactive")
    grant = enable_delegation(interactive_child, "subagents-toolkit", original_cwd=tmp_path / "interactive")
    assert grant.parent_session_id == interactive_child


def test_executions_migrate_to_the_fork_aware_schema_without_losing_their_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from subagents_runtime import storage

    state = tmp_path / "state"
    state.mkdir()
    schema = (Path(storage.__file__).parent / "resources" / "schema.sql").read_text(encoding="utf-8")
    previous = schema.replace(" fork_of TEXT, superseded_at TEXT, input_execution_id TEXT REFERENCES executions(id),\n", "").replace(" AND superseded_at IS NULL", "")
    previous = previous.split("CREATE TABLE loop_sessions", 1)[0]
    assert previous != schema
    connection = sqlite3.connect(state / "sessions.sqlite3")
    connection.executescript(previous)
    connection.executescript("""
        INSERT INTO sessions(id,provider_session_id,cwd) VALUES ('parent','parent','C:/work');
        INSERT INTO sessions(id,provider_session_id,cwd,parent_session_id,agent_index) VALUES ('child','child','C:/work','parent',1);
        INSERT INTO requests(id,parent_session_id,child_session_id,agent_number,state,mode) VALUES ('request','parent','child',1,'pending','interactive');
        INSERT INTO executions(id,session_id,request_id,backend,state,provider_pid) VALUES ('execution','child','request','standalone','running',4242);
        PRAGMA user_version=2;
    """)
    connection.commit()
    connection.close()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))

    with sessions._connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == storage.SCHEMA_VERSION
        assert connection.execute(
            "SELECT state,provider_pid,fork_of,superseded_at FROM executions WHERE id='execution'"
        ).fetchone() == ("running", 4242, None, None)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


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
