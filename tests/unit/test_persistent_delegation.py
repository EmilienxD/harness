import os
import subprocess

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


def test_conversation_inbox_is_short_and_reused_across_invocations(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions._register("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    assert inbox.is_dir() and len(inbox.name) <= 8
    assert enable_delegation("parent", "review-with-agent").inbox == inbox
    assert list(inbox.parent.iterdir()) == [inbox]


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


@pytest.mark.parametrize("model", [None, "claude-opus-5-5"])
@pytest.mark.parametrize("effort", [None, "xhigh"])
@pytest.mark.parametrize("changed", [None, "model", "effort"])
def test_recovery_retries_a_definitively_unspawned_reservation_with_original_identities(tmp_path, monkeypatch, model, effort, changed):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    model_field = f"model: {model}\n" if model is not None else ""
    effort_field = f"effort: {effort}\n" if effort is not None else ""
    (inbox / "task.md").write_text(f"---\ntask: general\nmode: auto\n{model_field}{effort_field}---\nTask.", encoding="utf-8")
    def crash_before_spawn(*_):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=crash_before_spawn)
    with sessions._connect() as connection:
        request_id, child_id = connection.execute("SELECT id,child_session_id FROM requests").fetchone()
        connection.execute("UPDATE executions SET reservation_pid=2147483647,reservation_birth='dead'")
    started = []
    if changed:
        changed_model = "model: claude-sonnet-5-5\n" if changed == "model" else model_field
        changed_effort = "effort: low\n" if changed == "effort" else effort_field
        (inbox / "task.md.running").write_text(f"---\ntask: general\nmode: auto\n{changed_model}{changed_effort}---\nTask.", encoding="utf-8")
    def adapter(request, identity, number, cwd):
        started.append((identity, number, cwd, request.model, request.effort))
        return child_id
    [recovered] = process_inbox("parent", launch=adapter)
    if changed:
        assert recovered.status == "failed"
        assert recovered.reason == "Claimed request metadata changed after reservation"
        assert started == []
    else:
        assert recovered.status == "launched" and recovered.child_session_id == child_id
        assert started == [(request_id, 1, tmp_path.resolve(), model, effort)]
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


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_runtime_context_is_replayed_then_acknowledged_and_compaction_starts_epoch(
    tmp_path, monkeypatch, provider
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    directory = ".claude" if provider == "claude" else ".agents"
    toolkit = tmp_path / directory / "skills" / "subagents-toolkit" / "SKILL.md"
    toolkit.parent.mkdir(parents=True)
    from subagents_runtime.roles import builtin_toolkit
    toolkit.write_bytes(builtin_toolkit().read_bytes())
    toolkit.with_name("builtin-tasks.yaml").write_bytes(
        builtin_toolkit().with_name("builtin-tasks.yaml").read_bytes()
    )
    payload = {
        "session_id": "parent",
        "cwd": str(tmp_path),
        "hook_event_name": "UserPromptSubmit",
        "prompt": ("/" if provider == "claude" else "$") + "work-with-agent do work",
    }
    assert handle(payload, provider) is not None
    assert handle({**payload, "prompt": "Continue the work."}, provider) is not None
    # A different observed event proves the previous injection reached the conversation.
    handle({**payload, "hook_event_name": "PreToolUse"}, provider)
    assert handle(payload, provider) is None
    compacted = handle(
        {**payload, "hook_event_name": "SessionStart", "source": "compact"}, provider
    )
    assert compacted is not None
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT context_epoch, injected_epoch FROM session_delegation WHERE parent_session_id='parent'"
        ).fetchone() == (1, 1)
    handle({**payload, "hook_event_name": "PreToolUse"}, provider)
    assert (
        handle({**payload, "hook_event_name": "SessionStart", "source": "resume"}, provider)
        is not None
    )


@pytest.mark.parametrize("compact", [False, True])
def test_runtime_context_delivery_does_not_load_instruction_documents(tmp_path, monkeypatch, compact):
    from pathlib import Path
    from subagents_runtime.delegation import claim_instructions

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox

    def unexpected_read(*_args, **_kwargs):
        pytest.fail("Runtime context delivery must not load instruction documents")

    monkeypatch.setattr(Path, "read_text", unexpected_read)
    assert claim_instructions("parent", compact=compact) is not None
    assert inbox.is_dir()


def test_loading_shared_skill_does_not_enable_delegation(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    assert handle({
        "session_id": "parent", "cwd": str(tmp_path),
        "hook_event_name": "PostToolUse", "tool_name": "Skill",
        "tool_input": {"skill": "subagents-toolkit"}, "tool_response": {"success": True},
    }, "claude") is None
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM session_delegation").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM requests").fetchone()[0] == 0


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_continuation_of_a_settled_child_keeps_its_identity_and_mode(
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


def _standalone_provider(tmp_path, monkeypatch, provider):
    """A delegated child whose launches stay in this runtime and record their argv."""
    from subagents_runtime import processes

    started = []
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _cwd: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider="claude": ["provider"])

    def start(execution_id, argv, _environment, _cwd, *, visible):
        started.append((argv, visible))
        processes.confirm_startup(execution_id)

    monkeypatch.setattr(processes, "start", start)
    sessions.register_observed("parent", tmp_path, provider)
    return started, enable_delegation("parent", "work-with-agent").inbox


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_live_child_is_continued_in_a_fork_under_the_same_identity(tmp_path, monkeypatch, provider):
    import os

    from subagents_runtime import processes

    started, inbox = _standalone_provider(tmp_path, monkeypatch, provider)
    (inbox / "first.md").write_text(
        "---\ntask: general\nmode: interactive\n---\nInitial task.", encoding="utf-8"
    )
    [first] = process_inbox("parent", launch=sessions.launch_delegated)
    with sessions._connect() as connection:
        connection.execute(
            "UPDATE sessions SET provider_session_id='saved-conversation' WHERE id=?",
            (first.child_session_id,),
        )
        # An idle interactive terminal: the provider process is still very much alive.
        connection.execute(
            "UPDATE executions SET state='running',provider_pid=?,provider_birth=? WHERE request_id=?",
            (os.getpid(), processes.birth_identity(os.getpid()), first.request_id),
        )
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nNext task.", encoding="utf-8"
    )

    [forked] = process_inbox("parent", launch=sessions.launch_delegated)

    assert forked.status == "launched"
    assert forked.child_session_id == first.child_session_id
    assert sessions.resolve_session("agent-1", "parent") == first.child_session_id
    argv, visible = started[-1]
    assert visible is True
    with sessions._connect() as connection:
        bound = connection.execute(
            "SELECT provider_session_id FROM sessions WHERE id=?", (first.child_session_id,)
        ).fetchone()[0]
    if provider == "claude":
        assert argv[argv.index("--resume") + 1] == "saved-conversation"
        assert "--fork-session" in argv
        assert bound == argv[argv.index("--session-id") + 1] != "saved-conversation"
    else:
        assert argv[1:3] == ["fork", "saved-conversation"]
        assert bound is None
    assert not list(inbox.iterdir())


def _live_delegated_child(tmp_path, monkeypatch, provider="claude"):
    """agent-1 with a bound conversation and a provider process still running."""
    import os

    from subagents_runtime import processes

    started, inbox = _standalone_provider(tmp_path, monkeypatch, provider)
    (inbox / "first.md").write_text(
        "---\ntask: general\nmode: interactive\n---\nInitial task.", encoding="utf-8"
    )
    [first] = process_inbox("parent", launch=sessions.launch_delegated)
    with sessions._connect() as connection:
        connection.execute(
            "UPDATE sessions SET provider_session_id='saved-conversation' WHERE id=?",
            (first.child_session_id,),
        )
        connection.execute(
            "UPDATE executions SET state='running',provider_pid=?,provider_birth=? WHERE request_id=?",
            (os.getpid(), processes.birth_identity(os.getpid()), first.request_id),
        )
    return started, inbox, first


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("schema_version", [3, 4])
def test_terminal_continuations_reply_through_the_original_process_hooks(tmp_path, monkeypatch, provider, schema_version):
    from subagents_runtime.delegation import arm_reply, report_child_stop, claim_parent_delivery, observe_parent_event
    from subagents_runtime.terminal_resume import prepare_terminal_resume

    _, inbox, first = _live_delegated_child(tmp_path, monkeypatch, provider)
    with sessions._connect() as connection:
        original = connection.execute("SELECT id FROM executions WHERE request_id=?", (first.request_id,)).fetchone()[0]
        connection.execute("UPDATE executions SET backend='aboard',aboard_agent_id='child',aboard_handle='terminal' WHERE id=?", (original,))
        if schema_version == 3:
            connection.execute("DROP TABLE loop_messages")
            connection.execute("DROP TABLE loop_waits")
            connection.execute("DROP TABLE loop_sessions")
            connection.execute("ALTER TABLE executions DROP COLUMN input_execution_id")
            connection.execute("PRAGMA user_version=3")

    def reuse(request, request_id, *_):
        with sessions._connect() as connection:
            execution = connection.execute("SELECT id FROM executions WHERE request_id=?", (request_id,)).fetchone()[0]
            connection.execute("UPDATE executions SET backend='aboard',state='starting' WHERE id=?", (execution,))
            connection.execute("UPDATE sessions SET provider_session_id=NULL WHERE id=?", (first.child_session_id,))
        prepare_terminal_resume(first.child_session_id, execution, "child", "terminal", "saved-conversation")
        return "saved-conversation"

    for index in range(2):
        (inbox / f"next-{index}.md").write_text("---\nresume: agent-1\n---\nNext task.", encoding="utf-8")
        [continued] = process_inbox("parent", launch=reuse)
        assert continued.status == "launched"
        arm_reply(first.child_session_id, original)
        assert report_child_stop(first.child_session_id, f"Result {index}", success=True, execution_id=original)
        delivered = claim_parent_delivery("parent", "SessionStart")
        assert delivered is not None
        assert f"Result {index}" in delivered.text
        observe_parent_event("parent", "PostToolUse")


def test_live_chatgpt_continuation_uses_aboard_instead_of_external_terminal(tmp_path, monkeypatch):
    import io
    import json

    started, inbox, first = _live_delegated_child(tmp_path, monkeypatch, "chatgpt")
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET aboard_agent_id='boarded-child',backend='aboard' WHERE request_id=?", (first.request_id,))
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _: ("127.0.0.1", 4823, "token"))
    requests = []

    def urlopen(request, **kwargs):
        body = json.loads(request.data)
        requests.append(body)
        from subagents_runtime.hooks import handle

        with monkeypatch.context() as child_environment:
            child_environment.setenv("HARNESS_SESSION_ID", body["harnessSessionId"])
            child_environment.setenv("HARNESS_EXECUTION_ID", body["executionId"])
            child_environment.setenv("HARNESS_EXECUTION_MODE", "interactive")
            handle({"session_id": "forked-conversation", "cwd": str(tmp_path), "hook_event_name": "SessionStart", "source": "startup"}, provider="chatgpt")
            assert sessions.resolve_session("agent-1", "parent") == body["harnessSessionId"]
            assert sessions.bind_observed("forked-conversation", tmp_path, "chatgpt") == body["harnessSessionId"]
        return io.BytesIO(b'{"agentId":"boarded-fork","sessionId":"forked-conversation","terminalId":"vscode-terminal"}')

    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    (inbox / "continue.md").write_text("---\nresume: agent-1\n---\nNext task.", encoding="utf-8")
    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "launched"
    assert len(started) == 1
    assert requests[0]["forkSessionId"] == "saved-conversation"
    assert requests[0]["resumeAgentId"] == "boarded-child"


def test_resume_command_forks_a_live_delegated_child(tmp_path, monkeypatch):
    started, _inbox, first = _live_delegated_child(tmp_path, monkeypatch)
    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")

    sessions.resume("agent-1", "Next task.")

    argv, _visible = started[-1]
    assert "--fork-session" in argv
    assert argv[argv.index("--resume") + 1] == "saved-conversation"
    assert sessions.resolve_session("agent-1", "parent") == first.child_session_id


def test_forked_conversation_starts_up_as_the_same_delegated_child(tmp_path, monkeypatch):
    import os

    from subagents_runtime import processes

    started, inbox = _standalone_provider(tmp_path, monkeypatch, "claude")
    (inbox / "first.md").write_text(
        "---\ntask: general\nmode: interactive\n---\nInitial task.", encoding="utf-8"
    )
    [first] = process_inbox("parent", launch=sessions.launch_delegated)
    with sessions._connect() as connection:
        connection.execute(
            "UPDATE sessions SET provider_session_id='saved-conversation' WHERE id=?",
            (first.child_session_id,),
        )
        connection.execute(
            "UPDATE executions SET state='running',provider_pid=?,provider_birth=? WHERE request_id=?",
            (os.getpid(), processes.birth_identity(os.getpid()), first.request_id),
        )
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nNext task.", encoding="utf-8"
    )
    process_inbox("parent", launch=sessions.launch_delegated)
    argv, _visible = started[-1]
    conversation = argv[argv.index("--session-id") + 1]
    with sessions._connect() as connection:
        execution = connection.execute(
            "SELECT id FROM executions WHERE fork_of IS NOT NULL"
        ).fetchone()[0]
    monkeypatch.setenv("HARNESS_EXECUTION_ID", execution)
    monkeypatch.setenv("HARNESS_SESSION_ID", first.child_session_id)

    handle(
        {
            "session_id": conversation,
            "cwd": str(tmp_path),
            "hook_event_name": "SessionStart",
            "source": "fork",
        },
        "claude",
    )

    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT id FROM sessions WHERE provider_session_id=?", (conversation,)
        ).fetchall() == [(first.child_session_id,)]


def test_a_superseded_session_cannot_answer_for_its_fork(tmp_path, monkeypatch):
    from subagents_runtime.delegation import arm_reply, report_child_stop

    _started, inbox, first = _live_delegated_child(tmp_path, monkeypatch)
    with sessions._connect() as connection:
        abandoned = connection.execute(
            "SELECT id FROM executions WHERE request_id=?", (first.request_id,)
        ).fetchone()[0]
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nNext task.", encoding="utf-8"
    )
    [forked] = process_inbox("parent", launch=sessions.launch_delegated)
    with sessions._connect() as connection:
        continuation = connection.execute(
            "SELECT id FROM executions WHERE request_id=?", (forked.request_id,)
        ).fetchone()[0]

    # The terminal the user left open finishes its own turn; it speaks for nobody now.
    with pytest.raises(sessions.SessionError, match="pending interactive"):
        arm_reply(first.child_session_id, abandoned)
    assert (
        report_child_stop(
            first.child_session_id, "Stale answer.", success=True, execution_id=abandoned
        )
        is False
    )

    arm_reply(first.child_session_id, continuation)
    assert (
        report_child_stop(
            first.child_session_id, "Forked answer.", success=True, execution_id=continuation
        )
        is True
    )


def test_a_fork_that_never_starts_gives_the_child_its_conversation_back(
    tmp_path, monkeypatch
):
    from subagents_runtime import processes

    _started, inbox, first = _live_delegated_child(tmp_path, monkeypatch)

    def refuse(*_args, **_kwargs):
        raise OSError("the terminal could not be opened")

    monkeypatch.setattr(processes, "start", refuse)
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nNext task.", encoding="utf-8"
    )

    [failed] = process_inbox("parent", launch=sessions.launch_delegated)

    assert failed.status == "failed"
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT provider_session_id FROM sessions WHERE id=?",
            (first.child_session_id,),
        ).fetchone() == ("saved-conversation",)


def test_fork_settles_the_superseded_request_without_telling_the_parent(tmp_path, monkeypatch):
    from subagents_runtime.delegation import (
        arm_reply,
        claim_parent_delivery,
        report_child_stop,
    )

    _started, inbox, first = _live_delegated_child(tmp_path, monkeypatch)
    (inbox / "next.md").write_text(
        "---\nresume: agent-1\n---\nNext task.", encoding="utf-8"
    )
    [forked] = process_inbox("parent", launch=sessions.launch_delegated)

    # Superseding is bookkeeping between the runtime and its child, not news to deliver.
    assert claim_parent_delivery("parent", "Stop") is None
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT state FROM requests WHERE id=?", (first.request_id,)
        ).fetchone() == ("cancelled",)
        continuation = connection.execute(
            "SELECT id FROM executions WHERE request_id=?", (forked.request_id,)
        ).fetchone()[0]
    arm_reply(first.child_session_id, continuation)
    report_child_stop(
        first.child_session_id, "Forked answer.", success=True, execution_id=continuation
    )

    delivery = claim_parent_delivery("parent", "Stop")

    assert delivery is not None and "Forked answer." in delivery.text
    assert "cancelled" not in delivery.text


@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_fork_arguments_copy_the_conversation_natively(mode):
    claude = sessions.provider_arguments(
        "claude", mode, "conversation", "next", fork=True, fork_id="copy"
    )
    chatgpt = sessions.provider_arguments("chatgpt", mode, "conversation", "next", fork=True)

    headless = ["-p", "--output-format", "stream-json", "--verbose"] if mode == "auto" else []
    assert claude == [
        *headless,
        "--resume",
        "conversation",
        "--fork-session",
        "--session-id",
        "copy",
        "--",
        "next",
    ]
    assert chatgpt == (
        ["exec", "fork", "conversation", "--json", "--", "next"]
        if mode == "auto"
        else ["fork", "conversation", "--", "next"]
    )


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
    launch = tmp_path / ".harness" / "config.json"
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


def test_overlapping_whole_inbox_scans_launch_each_request_once(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    for i in range(4):
        (inbox / f"{i}.md").write_text("---\ntask: general\nmode: auto\n---\nWork.", encoding="utf-8")
    (inbox / "invalid.md").write_text("---\ntask: unknown\nmode: auto\n---\nWork.", encoding="utf-8")
    gate = Barrier(4)
    launched = []
    def scan(_index):
        gate.wait(timeout=10)
        return process_inbox("parent", launch=lambda request, *_args: launched.append(request.path.name) or request.path.stem)

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = [result for batch in workers.map(scan, range(4)) for result in batch]

    assert sorted(launched) == [f"{i}.md" for i in range(4)]
    assert sum(result.status == "launched" for result in results) == 4
    assert sum(result.status == "failed" for result in results) == 1
    with sessions._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 5
        assert db.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 4
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


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_parent_resume_delivers_dead_child_interruption_without_restarting_it(
    tmp_path, monkeypatch, provider, mode
):
    from subagents_runtime.delegation import claim_parent_delivery, has_pending_children

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        f"---\ntask: general\nmode: {mode}\n---\nTask.", encoding="utf-8"
    )
    [child] = process_inbox("parent", launch=lambda *_: "saved-conversation")
    with sessions._connect() as connection:
        connection.execute(
            "UPDATE executions SET supervisor_pid=2147483647,supervisor_birth='dead',provider_pid=2147483647,provider_birth='dead'"
        )
    # Acknowledge the original instructions, so only the interruption produces context.
    handle({"session_id": "parent", "cwd": str(tmp_path), "hook_event_name": "UserPromptSubmit"}, provider)
    handle({"session_id": "parent", "cwd": str(tmp_path), "hook_event_name": "PreToolUse"}, provider)
    output = handle(
        {"session_id": "parent", "cwd": str(tmp_path), "hook_event_name": "SessionStart", "source": "resume"},
        provider,
    )
    assert output is not None
    assert not has_pending_children("parent")
    assert claim_parent_delivery("parent", "SessionStart") is not None
    assert sessions.resolve_session("agent-1", "parent") == child.child_session_id
    assert not list(inbox.iterdir())


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_inbox_resume_refuses_child_without_saved_conversation(tmp_path, monkeypatch, provider):
    from subagents_runtime.delegation import report_child_stop

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    [child] = process_inbox("parent", launch=lambda *_: "conversation")
    report_child_stop(child.child_session_id, "", success=False, cancelled=True)
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET state='exited'")
        connection.execute("UPDATE sessions SET provider_session_id=NULL WHERE id=?", (child.child_session_id,))
    (inbox / "resume.md").write_text("---\nresume: agent-1\n---\nContinue.", encoding="utf-8")
    launches = []
    [result] = process_inbox("parent", launch=lambda *args: launches.append(args) or child.child_session_id)
    assert result.status == "failed"
    assert result.reason == "Provider conversation has not been bound; resume refused"
    assert not launches


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


def test_aboard_refusal_fails_definitively_and_reports_its_reason(tmp_path, monkeypatch):
    import io
    import json
    import urllib.error

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    monkeypatch.setattr(
        sessions, "_discover_delegation_endpoint", lambda cwd: ("127.0.0.1", 4823, "t")
    )
    body = json.dumps(
        {
            "ok": False,
            "error": {
                "code": "conflict",
                "message": "Delegated session ownership does not match",
            },
        }
    ).encode("utf-8")

    def refuse(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url, 409, "Conflict", {}, io.BytesIO(body)
        )

    monkeypatch.setattr(sessions.urllib.request, "urlopen", refuse)

    [refused] = process_inbox("parent", launch=sessions.launch_delegated)

    assert refused.status == "failed"
    assert "Delegated session ownership does not match" in refused.reason
    assert not list(inbox.iterdir())


def test_aboard_uncertain_startup_keeps_its_reservation_for_recovery(
    tmp_path, monkeypatch
):
    import io
    import json
    import urllib.error

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )
    monkeypatch.setattr(
        sessions, "_discover_delegation_endpoint", lambda cwd: ("127.0.0.1", 4823, "t")
    )
    body = json.dumps(
        {
            "ok": False,
            "error": {
                "code": "startup-uncertain",
                "message": "Delegation startup is uncertain; verify the existing execution",
            },
        }
    ).encode("utf-8")

    def refuse(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url, 409, "Conflict", {}, io.BytesIO(body)
        )

    monkeypatch.setattr(sessions.urllib.request, "urlopen", refuse)

    [unresolved] = process_inbox("parent", launch=sessions.launch_delegated)

    assert unresolved.status == "uncertain"
    assert (inbox / "task.md.running").is_file()


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


@pytest.mark.skipif(os.name != "nt", reason="Windows process creation contract")
def test_headless_provider_does_not_open_a_windows_console(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    from subagents_runtime import processes

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "task.md").write_text(
        "---\ntask: general\nmode: auto\n---\nTask.", encoding="utf-8"
    )

    with pytest.raises(KeyboardInterrupt):
        process_inbox(
            "parent", launch=lambda *_: (_ for _ in ()).throw(KeyboardInterrupt())
        )
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
    launches = []
    fake_provider = SimpleNamespace(
        pid=os.getpid(), stdout=[], wait=lambda: 0, poll=lambda: 0
    )

    def popen(*args, **kwargs):
        launches.append((args, kwargs))
        return fake_provider

    monkeypatch.setattr(processes, "native_command", lambda argv: argv)
    monkeypatch.setattr(processes.subprocess, "Popen", popen)

    processes.supervise(execution, specification)

    assert launches[0][1].get("creationflags") == subprocess.CREATE_NO_WINDOW


@pytest.mark.parametrize("live", [False, True])
def test_continuation_recovers_requested_effort(tmp_path, monkeypatch, live):
    from subagents_runtime import processes

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "chatgpt")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "work.md").write_text("---\ntask: general\nmode: auto\neffort: ultra\n---\nWork.", encoding="utf-8")
    [first] = process_inbox("parent", launch=lambda *_: "provider-child")
    assert first.status == "launched", first.reason
    with sessions._connect() as connection:
        assert connection.execute("SELECT effort FROM sessions WHERE id=?", (first.child_session_id,)).fetchone() == ("ultra",)
        connection.execute("UPDATE executions SET state='exited' WHERE request_id=?", (first.request_id,))
        connection.execute("UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,))
        if live:
            connection.execute("UPDATE executions SET state='running',provider_pid=?,provider_birth=? WHERE request_id=?", (os.getpid(), processes.birth_identity(os.getpid()), first.request_id))
    (inbox / "continue.md").write_text("---\nresume: agent-1\n---\nContinue.", encoding="utf-8")
    efforts = []
    [continued] = process_inbox("parent", launch=lambda request, *_: efforts.append(request.effort) or "continued-provider")
    assert continued.status == "launched", continued.reason
    assert efforts == ["ultra"]


@pytest.mark.parametrize("schema_version", [6, 7])
def test_effort_migration_preserves_existing_children(tmp_path, monkeypatch, schema_version):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "old.md").write_text("---\ntask: general\nmode: auto\n---\nWork.", encoding="utf-8")
    [first] = process_inbox("parent", launch=lambda *_: "provider-child")
    assert first.status == "launched", first.reason
    with sessions._connect() as connection:
        connection.execute("ALTER TABLE sessions DROP COLUMN effort")
        if schema_version == 6:
            connection.execute("ALTER TABLE sessions DROP COLUMN model")
        connection.execute(f"PRAGMA user_version={schema_version}")
    (inbox / "new.md").write_text("---\ntask: general\nmode: auto\neffort: high\n---\nWork.", encoding="utf-8")
    efforts = []
    [second] = process_inbox("parent", launch=lambda request, *_: efforts.append(request.effort) or "provider-new")
    assert second.status == "launched", second.reason
    assert efforts == ["high"]
    assert sessions.resolve_session("agent-1", "parent") == first.child_session_id
    with sessions._connect() as connection:
        assert connection.execute("SELECT effort FROM sessions WHERE id=?", (first.child_session_id,)).fetchone() == (None,)
        assert connection.execute("SELECT effort FROM sessions WHERE id=?", (second.child_session_id,)).fetchone() == ("high",)
