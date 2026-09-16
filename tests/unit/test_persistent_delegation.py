import pytest
from subagents_runtime import sessions
from subagents_runtime.delegation import enable_delegation, process_inbox
from subagents_runtime.hooks import handle


@pytest.mark.parametrize("source", ["clear", "fork"])
def test_fresh_conversation_does_not_bind_inherited_unbound_session(tmp_path, monkeypatch, source):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions._register("original", tmp_path, "chatgpt")
    original = enable_delegation("original", "work-with-agent")
    monkeypatch.setenv("HARNESS_SESSION_ID", "original")
    assert handle({"session_id": "fresh", "cwd": str(tmp_path),
                   "hook_event_name": "SessionStart", "source": source}, "chatgpt") is None
    fresh = enable_delegation("fresh", "work-with-agent")
    assert fresh.parent_session_id == "fresh" and fresh.inbox != original.inbox
    with sessions._connect() as connection:
        assert connection.execute("SELECT provider_session_id FROM sessions WHERE id='original'").fetchone() == (None,)


def test_resume_refuses_live_provider_without_birth_identity_even_if_supervisor_exited(tmp_path, monkeypatch):
    from subagents_runtime import processes
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("child", tmp_path, "claude")
    with sessions._connect() as connection:
        connection.execute("INSERT INTO executions(id,session_id,backend,state,supervisor_pid,supervisor_birth,provider_pid) VALUES ('execution','child','standalone','uncertain',123,'old-birth',456)")
    monkeypatch.setattr(processes, "birth_identity", lambda pid: None)
    monkeypatch.setattr(processes, "process_alive", lambda pid: pid == 456)
    with pytest.raises(sessions.SessionError, match="resume refused"):
        processes.require_exited("child")


def test_recovery_retries_a_definitively_unspawned_reservation_with_original_identities(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")
    def crash_before_spawn(*_):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=crash_before_spawn)
    with sessions._connect() as connection:
        request_id, child_id = connection.execute("SELECT id,child_session_id FROM requests").fetchone()
        connection.execute("UPDATE executions SET reservation_pid=2147483647,reservation_birth='dead'")
    started = []
    def adapter(request, identity, number, cwd):
        started.append((identity, number, cwd))
        return child_id
    [recovered] = process_inbox("parent", launch=adapter)
    assert recovered.status == "launched" and recovered.child_session_id == child_id
    assert started == [(request_id, 1, tmp_path.resolve())]
    assert not list(inbox.iterdir())


def test_execution_reservation_cannot_reference_another_requests_child(tmp_path, monkeypatch):
    import sqlite3
    from subagents_runtime.storage import connect
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    sessions.register_observed("unrelated", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")
    [started] = process_inbox("parent", launch=lambda *_: "conversation")
    with connect() as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE executions SET session_id='unrelated' WHERE request_id=?", (started.request_id,))


def test_recovery_delivers_definite_startup_failure_and_removes_claimed_file(tmp_path, monkeypatch):
    from subagents_runtime.delegation import claim_parent_delivery
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")
    def crash(*_):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=crash)
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET state='failed'")
    process_inbox("parent", launch=lambda *_: pytest.fail("must not relaunch"))
    delivery = claim_parent_delivery("parent", "SessionStart")
    assert delivery is not None
    assert not list(inbox.iterdir())


def test_saved_conversation_has_one_persistent_inbox_for_all_tasks(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude", "auto")
    first = enable_delegation("parent", "explore-with-agent")
    handle(
        {"session_id": "parent", "cwd": str(tmp_path), "hook_event_name": "SessionEnd"}
    )
    second = enable_delegation("parent", "work-with-agent")
    assert first.inbox == second.inbox
    assert first.inbox.is_relative_to(tmp_path / "state")
    path = first.inbox / "work.md"
    path.write_text(
        "---\ntask: general\nmode: auto\n---\nDo the work.", encoding="utf-8"
    )
    results = process_inbox("parent", launch=lambda *_: "child")
    assert results[0].status == "launched"
    assert not path.exists()
    assert not list(first.inbox.iterdir())


def test_instruction_delivery_is_replayed_then_acknowledged_and_compaction_starts_epoch(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    payload = {
        "session_id": "parent",
        "cwd": str(tmp_path),
        "hook_event_name": "UserPromptSubmit",
        "prompt": "/work-with-agent do work",
    }
    assert handle(payload) is not None
    assert handle({**payload, "prompt": "Continue the work."}) is not None
    # A different observed event proves the previous injection reached the conversation.
    handle({**payload, "hook_event_name": "PreToolUse"})
    assert handle(payload) is None
    compacted = handle(
        {**payload, "hook_event_name": "SessionStart", "source": "compact"}
    )
    assert compacted is not None
    handle({**payload, "hook_event_name": "PreToolUse"})
    assert (
        handle({**payload, "hook_event_name": "SessionStart", "source": "resume"})
        is None
    )


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_continuation_keeps_child_identity_and_mode_and_refuses_live_execution(
    tmp_path, monkeypatch, provider, mode
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "work-with-agent").inbox
    source = inbox / "first.md"
    source.write_text(
        f"---\ntask: general\nmode: {mode}\n---\nInitial task.", encoding="utf-8"
    )
    [first] = process_inbox("parent", launch=lambda *_: "conversation")
    from subagents_runtime.delegation import arm_reply, report_child_stop

    if mode == "interactive":
        arm_reply(first.child_session_id)
    report_child_stop(first.child_session_id, "Done", success=True)
    continuation = inbox / "next.md"
    continuation.write_text("---\nresume: agent-1\n---\nNext task.", encoding="utf-8")
    [refused] = process_inbox("parent", launch=lambda *_: pytest.fail("overlap"))
    assert refused.status == "failed"
    assert "resume refused" in refused.reason
    # Provider process exit is a separate observation from its reply.
    with sessions._connect() as connection:
        connection.execute(
            "UPDATE executions SET state='exited' WHERE session_id=?",
            (first.child_session_id,),
        )
    continuation = inbox / "retry.md"
    continuation.write_text("---\nresume: agent-1\n---\nNext task.", encoding="utf-8")
    captured = []

    def adapter(request, request_id, number, cwd):
        captured.append((request.provider, request.mode, number, cwd, request.prompt))
        return first.child_session_id

    [second] = process_inbox("parent", launch=adapter)
    assert second.child_session_id == first.child_session_id
    assert captured == [(provider, mode, 1, tmp_path.resolve(), "Next task.")]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_background_adapter_uses_native_headless_resume_arguments(provider):
    args = sessions.provider_arguments(
        provider, "auto", "conversation", "next", resume=True
    )
    if provider == "claude":
        assert args == [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--resume",
            "conversation",
            "--",
            "next",
        ]
    else:
        assert args == ["exec", "resume", "conversation", "--json", "--", "next"]
    assert sessions.provider_arguments(
        provider, "interactive", "conversation", "--permission-option", resume=True
    )[-2:] == ["--", "--permission-option"]


def test_detached_supervisor_binds_conversation_and_delivers_after_process_exit(
    tmp_path, monkeypatch
):
    import json
    import sys
    import time

    from subagents_runtime.delegation import claim_parent_delivery

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _: None)
    monkeypatch.setattr(
        sessions, "_visible_terminal", lambda *_: pytest.fail("visible terminal opened")
    )
    provider = tmp_path / "provider.py"
    provider.write_text(
        'import json\nprint(json.dumps({"type":"thread.started","thread_id":"saved-conversation"}),flush=True)\nprint(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Done"}}),flush=True)\n',
        encoding="utf-8",
    )
    launch = tmp_path / ".harness" / "launch.json"
    launch.parent.mkdir()
    launch.write_text(
        json.dumps(
            {
                "version": 1,
                "autoRun": {"provider": "claude"},
                "providers": {
                    "claude": {},
                    "chatgpt": {"command": [sys.executable, str(provider)]},
                },
            }
        ),
        encoding="utf-8",
    )
    sessions.register_observed("parent", tmp_path, "chatgpt")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    request = inbox / "work.md"
    request.write_text("---\ntask: general\nmode: auto\n---\nWork.", encoding="utf-8")
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    assert result.status == "launched"
    deadline = time.monotonic() + 5
    delivery = None
    while delivery is None and time.monotonic() < deadline:
        delivery = claim_parent_delivery("parent", "SessionStart")
        time.sleep(0.01)
    assert delivery is not None
    assert not list(inbox.iterdir())
    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")
    assert sessions.resolve_session("agent-1") == result.child_session_id


def test_resume_replays_unacknowledged_delivery_instead_of_acknowledging_it(
    tmp_path, monkeypatch
):
    from subagents_runtime.delegation import claim_parent_delivery, report_child_stop

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    [started] = process_inbox("parent", launch=lambda *_: "child")
    report_child_stop(started.child_session_id, "Result", success=True)
    first = claim_parent_delivery("parent", "PostToolUse")
    assert first is not None
    output = handle(
        {
            "session_id": "parent",
            "cwd": str(tmp_path),
            "hook_event_name": "SessionStart",
            "source": "resume",
        }
    )
    assert output is not None
    replay = claim_parent_delivery("parent", "SessionStart")
    assert replay is not None and replay.delivery_id == first.delivery_id


def test_concurrent_requests_allocate_stable_distinct_parent_scoped_identifiers(
    tmp_path, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    sources = []
    for i in range(8):
        source = inbox / f"{i}.md"
        source.write_text(
            "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
        )
        sources.append(source)

    def run(source):
        return process_inbox(
            "parent",
            request_paths={source},
            launch=lambda request, request_id, number, cwd: f"conversation-{number}",
        )

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = [result for batch in workers.map(run, sources) for result in batch]
    assert len(results) == 8 and all(result.status == "launched" for result in results)
    ids = {sessions.resolve_session(f"agent-{i}", "parent") for i in range(1, 9)}
    assert ids == {result.child_session_id for result in results}
    assert not list(inbox.iterdir())


def test_crash_after_spawn_intent_retains_uncertainty_and_never_relaunches(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    source = inbox / "work.md"
    source.write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")

    class Crash(BaseException):
        pass

    def launch(*_):
        with sessions._connect() as connection:
            connection.execute("UPDATE executions SET state='starting'")
        raise Crash()

    with pytest.raises(Crash):
        process_inbox("parent", launch=launch)
    from subagents_runtime import processes

    monkeypatch.setattr(processes, "birth_identity", lambda pid: "reused-pid")
    [recovered] = process_inbox(
        "parent", launch=lambda *_: pytest.fail("duplicate launch")
    )
    assert recovered.status == "uncertain"
    assert (inbox / "work.md.running").is_file()
    from subagents_runtime.processes import require_exited

    with pytest.raises(sessions.SessionError, match="uncertain"):
        require_exited(sessions.resolve_session("agent-1", "parent"))


def test_claim_without_committed_reservation_can_be_retried(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    source = inbox / "claimed.md"
    source.write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")
    source.rename(source.with_name(source.name + ".running"))
    calls = []
    [result] = process_inbox(
        "parent", launch=lambda *args: calls.append(args) or "child"
    )
    assert result.status == "launched" and len(calls) == 1
    assert not list(inbox.iterdir())


def test_confirmed_startup_survives_interrupted_caller_without_relaunch(
    tmp_path, monkeypatch
):
    from subagents_runtime.processes import confirm_startup

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    source = inbox / "confirmed.md"
    source.write_text("---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8")

    def interrupted_launch(request, request_id, number, cwd):
        with sessions._connect() as connection:
            execution_id = connection.execute(
                "SELECT id FROM executions WHERE request_id=?", (request_id,)
            ).fetchone()[0]
        confirm_startup(execution_id)
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=interrupted_launch)
    assert not list(inbox.iterdir())
    assert (
        process_inbox("parent", launch=lambda *_: pytest.fail("duplicate launch")) == []
    )
    with sessions._connect() as connection:
        assert (
            connection.execute(
                "SELECT state,source_deleted_at FROM requests"
            ).fetchone()[0]
            == "pending"
        )


@pytest.mark.parametrize("request_state", ["pending", "uncertain"])
def test_verified_dead_process_completes_abandoned_request_and_allows_resume(
    tmp_path, monkeypatch, request_state
):
    from subagents_runtime import processes
    from subagents_runtime.delegation import claim_parent_delivery

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "original.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    [first] = process_inbox("parent", launch=lambda *_: "saved-conversation")
    with sessions._connect() as connection:
        connection.execute("UPDATE requests SET state=?", (request_state,))
        connection.execute(
            "UPDATE executions SET supervisor_pid=123,supervisor_birth='original-birth',provider_pid=456,provider_birth='original-birth'"
        )
    monkeypatch.setattr(processes, "birth_identity", lambda pid: "reused-pid")
    processes.require_exited(first.child_session_id)
    assert claim_parent_delivery("parent", "SessionStart") is not None
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nContinue.", encoding="utf-8"
    )
    [resumed] = process_inbox("parent", launch=lambda *_: "saved-conversation")
    assert (
        resumed.status == "launched"
        and resumed.child_session_id == first.child_session_id
    )


def test_legacy_grants_consolidate_running_files_and_preserve_indices_and_acks(
    tmp_path, monkeypatch
):
    import sqlite3

    state = tmp_path / "state"
    state.mkdir()
    old_inbox = tmp_path / "legacy-inbox"
    old_inbox.mkdir()
    (old_inbox / "pending.md.running").write_text("pending", encoding="utf-8")
    (old_inbox / "done.md").write_text("completed", encoding="utf-8")
    with sqlite3.connect(state / "sessions.sqlite3") as connection:
        connection.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY, claude_session_id TEXT, cwd TEXT, provider TEXT, execution_mode TEXT);
            CREATE TABLE requests(id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT, agent_number INTEGER,
                source_name TEXT, grant_id TEXT, state TEXT, reply TEXT, delivery_id TEXT, acknowledged_at TEXT);
            CREATE TABLE grants(id TEXT PRIMARY KEY,parent_session_id TEXT,inbox TEXT);
        """)
        connection.executemany(
            "INSERT INTO sessions VALUES (?,?,?,?,?)",
            [
                ("parent", "parent-native", str(tmp_path), "chatgpt", "interactive"),
                ("pending-child", "pending-native", str(tmp_path), "chatgpt", "auto"),
                ("done-child", "done-native", str(tmp_path), "chatgpt", "interactive"),
            ],
        )
        connection.execute(
            "INSERT INTO grants VALUES ('grant','parent',?)", (str(old_inbox),)
        )
        connection.executemany(
            "INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    "pending",
                    "parent",
                    "pending-child",
                    3,
                    "pending.md",
                    "grant",
                    "pending",
                    None,
                    None,
                    None,
                ),
                (
                    "done",
                    "parent",
                    "done-child",
                    8,
                    "done.md",
                    "grant",
                    "replied",
                    "answer",
                    "stable-delivery",
                    "2026-01-01",
                ),
            ],
        )
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    with sessions._connect() as connection:
        inbox = connection.execute(
            "SELECT inbox FROM session_delegation WHERE parent_session_id='parent'"
        ).fetchone()[0]
        assert connection.execute(
            "SELECT provider_session_id,agent_index,execution_mode FROM sessions WHERE id='pending-child'"
        ).fetchone() == ("pending-native", 3, "auto")
        assert connection.execute(
            "SELECT delivery_id,acknowledgement_sequence FROM requests WHERE id='done'"
        ).fetchone() == ("stable-delivery", 1)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert sessions.resolve_session("agent-3", "parent") == "pending-child"
    assert not list(old_inbox.iterdir())
    from pathlib import Path

    assert [p.name for p in Path(inbox).iterdir()] == ["pending.md.running"]
    [recovered] = process_inbox(
        "parent", launch=lambda *_: pytest.fail("legacy duplicate launch")
    )
    assert recovered.status == "uncertain"


def test_successful_skill_tool_enables_saved_conversation_without_slash_prompt(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    output = handle(
        {
            "session_id": "parent",
            "cwd": str(tmp_path),
            "hook_event_name": "PostToolUse",
            "tool_name": "Skill",
            "tool_input": {"skill": "resume-agent"},
            "tool_response": {"success": True},
        }
    )
    assert output is not None
    with sessions._connect() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM session_delegation WHERE parent_session_id='parent'"
            ).fetchone()[0]
            == 1
        )
    output = handle(
        {
            "session_id": "fresh",
            "cwd": str(tmp_path),
            "hook_event_name": "SessionStart",
            "source": "fork",
        }
    )
    assert output is None
    with sessions._connect() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM session_delegation WHERE parent_session_id='fresh'"
            ).fetchone()[0]
            == 0
        )


def test_aboard_receives_runtime_location_and_execution_identity(tmp_path, monkeypatch):
    import io
    import json

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "isolated-state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    monkeypatch.setattr(
        sessions,
        "_discover_delegation_endpoint",
        lambda cwd: ("127.0.0.1", 4823, "dummy"),
    )
    sent = []

    def response(request, timeout):
        sent.append(json.loads(request.data))
        return io.BytesIO(
            b'{"ok":true,"sessionId":"provider-id","agentId":"aboard-child","terminalId":"headless-handle"}'
        )

    monkeypatch.setattr(sessions.urllib.request, "urlopen", response)
    [started] = process_inbox("parent", launch=sessions.launch_delegated)
    assert started.status == "launched" and not list(inbox.iterdir())
    assert sent[0]["harnessSessionId"] == started.child_session_id
    assert sent[0]["harnessStateDirectory"] == str(
        (tmp_path / "isolated-state").resolve()
    )
    assert sent[0]["harnessRuntimePath"] == str(
        sessions.Path(sessions.__file__).resolve().parent.parent
    )
    with sessions._connect() as connection:
        assert (
            connection.execute("SELECT id FROM executions").fetchone()[0]
            == sent[0]["executionId"]
        )
        connection.execute(
            "UPDATE requests SET state='uncertain',reason='Provider liveness could not be verified'"
        )
        connection.execute("UPDATE executions SET state='uncertain'")
    [recovered] = process_inbox(
        "parent", launch=lambda *_: pytest.fail("duplicate launch")
    )
    assert (
        recovered.status == "uncertain"
        and recovered.child_session_id == started.child_session_id
    )


def test_aboard_wrapper_error_preserves_live_provider_identity_and_marker(
    tmp_path, monkeypatch
):
    import importlib.util
    import sys
    from pathlib import Path
    from types import SimpleNamespace

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )

    def interrupted(*_):
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=interrupted)
    with sessions._connect() as connection:
        execution = connection.execute("SELECT id FROM executions").fetchone()[0]
    wrapper_path = (
        Path(__file__).resolve().parents[2]
        / "apps/aboard/assets/runtime/abd_wrapper.py"
    )
    spec = importlib.util.spec_from_file_location("test_aboard_wrapper", wrapper_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    marker = tmp_path / "child.lock"
    monkeypatch.setattr(sys, "argv", [str(wrapper_path), str(marker), "--", "provider"])
    monkeypatch.setenv("HARNESS_EXECUTION_ID", execution)

    def broken_wait():
        raise RuntimeError("wrapper observation failed")

    fake_provider = SimpleNamespace(pid=123, poll=lambda: None, wait=broken_wait)
    monkeypatch.setattr(
        module.subprocess, "Popen", lambda *args, **kwargs: fake_provider
    )
    assert module.main() == 1
    assert marker.is_file()
    with sessions._connect() as connection:
        state, provider, supervisor_birth = connection.execute(
            "SELECT state,provider_pid,supervisor_birth FROM executions"
        ).fetchone()
        assert state == "uncertain" and provider == 123 and supervisor_birth


def test_supervisor_error_keeps_live_provider_uncertain(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    from subagents_runtime import processes

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )

    def interrupted(*_):
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=interrupted)
    child = sessions.resolve_session("agent-1", "parent")
    with sessions._connect() as connection:
        execution = connection.execute("SELECT id FROM executions").fetchone()[0]
    specification = tmp_path / "launch.json"
    specification.write_text(
        json.dumps(
            {
                "argv": ["provider"],
                "environment": {"HARNESS_SESSION_ID": child},
                "cwd": str(tmp_path),
                "visible": False,
            }
        ),
        encoding="utf-8",
    )
    fake_provider = SimpleNamespace(pid=123, stdout=[b"[]\n"], poll=lambda: None)
    monkeypatch.setattr(processes, "native_command", lambda argv: argv)
    monkeypatch.setattr(
        processes.subprocess, "Popen", lambda *args, **kwargs: fake_provider
    )
    assert processes.supervise(execution, specification) == 1
    with sessions._connect() as connection:
        assert (
            connection.execute("SELECT state FROM executions").fetchone()[0]
            == "uncertain"
        )
    with pytest.raises(sessions.SessionError, match="uncertain"):
        processes.require_exited(child)
