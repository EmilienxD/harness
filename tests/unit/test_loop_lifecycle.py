"""Loop lifecycle contracts through provider hooks and the runtime CLI."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import os
import subprocess
import sys
import io

import pytest

from subagents_runtime import hooks, loop, processes, sessions
from subagents_runtime.cli import main
from subagents_runtime.delegation import enable_delegation, process_inbox


def configured(tmp_path, monkeypatch, provider, difficulty=None):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    monkeypatch.delenv("HARNESS_EXECUTION_ID", raising=False)
    sessions.register_observed("lead", tmp_path, provider)
    inbox = enable_delegation("lead", "ship").inbox
    prompt = tmp_path / "prompt.md"
    prompt.write_text("Implement the criteria.", encoding="utf-8")
    (inbox / "loop.md").write_text(
        f'---\nmode: loop\ncwd: {json.dumps(str(tmp_path))}\nprompt-file: {json.dumps(str(prompt))}\n'
        + (f'difficulty: {difficulty}\n' if difficulty else '') + '---\nImplement.\n',
        encoding="utf-8",
    )
    result = process_inbox("lead", launch=lambda *_: "provider-child")[0]
    assert result.status == "launched", result.reason
    assert result.child_session_id is not None
    child = result.child_session_id
    return child


def event(tmp_path, provider, session, name, **extra):
    return hooks.handle({"session_id": session, "cwd": str(tmp_path), "hook_event_name": name, **extra}, provider)


def waiting(child):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        value = loop.lookup(child)
        if value.get("wait", {}).get("state") == "waiting":
            return value["wait"]["token"]
        time.sleep(.01)
    raise AssertionError("implementer did not wait")


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("invalid_surrogate", [False, True])
def test_utf8_prompt_storage_preserves_loop_takeover(
    tmp_path, monkeypatch, capsys, provider, invalid_surrogate,
):
    child = configured(tmp_path, monkeypatch, provider)
    narrative = "caf\u00e9 \u4e2d \U0001f680" + ("\ud800" if invalid_surrogate else "")
    payload = {
        "session_id": child, "cwd": str(tmp_path),
        "hook_event_name": "UserPromptSubmit", "prompt": narrative,
    }
    # Keep the lone surrogate JSON-escaped, while valid text uses raw UTF-8.
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8", errors="backslashreplace")
    stream = io.TextIOWrapper(io.BytesIO(raw), encoding="cp1252", errors="surrogateescape")
    monkeypatch.setattr(sys, "stdin", stream)
    monkeypatch.setattr(sys, "argv", ["harness-subagents-hook", f"--{provider}"])
    with ThreadPoolExecutor() as pool:
        stopped = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="report")
        token = waiting(child)
        assert hooks.main() == 0
        assert not capsys.readouterr().out
        assert stopped.result(timeout=5) is None
    assert loop.lookup(child)["active"] is True
    assert loop.lookup(child)["wait"]["state"] == "taken-over"
    with pytest.raises(sessions.SessionError):
        loop.respond(child, token, feedback="stale verdict")
    with sessions._connect() as db:
        records = db.execute("SELECT source,message FROM loop_messages WHERE session_id=?", (child,)).fetchall()
    # Stored user narrative is data, independent of generated agent instructions.
    assert records == [(child, narrative.replace("\ud800", "\ufffd"))]


def test_invalid_utf8_prompt_keeps_subagents_fail_closed(monkeypatch, capsys):
    stream = io.TextIOWrapper(io.BytesIO(b'{"prompt":"\xff"}'), encoding="cp1252")
    monkeypatch.setattr(sys, "stdin", stream)
    monkeypatch.setattr(sys, "argv", ["harness-subagents-hook", "--chatgpt"])
    assert hooks.main() == 0
    assert json.loads(capsys.readouterr().out)["decision"] == "block"


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("schema_version", [5, 6])
def test_automatic_reports_feedback_and_release_use_same_session(tmp_path, monkeypatch, capsys, provider, schema_version):
    child = configured(tmp_path, monkeypatch, provider)
    if schema_version == 5:
        with sessions._connect() as db:
            db.execute("DROP TABLE loop_messages")
            db.execute("DROP TABLE loop_waits")
            db.execute("PRAGMA user_version=5")
    feedback = tmp_path / "feedback.md"
    feedback.write_text("Finish the missing workflow.", encoding="utf-8")
    with ThreadPoolExecutor() as pool:
        first = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="round one")
        token = waiting(child)
        delivery = event(tmp_path, provider, "lead", "Stop")
        assert delivery is not None
        assert main(["loop", "feedback", child, "--wait-token", token, "--file", str(feedback)]) == 0
        output = first.result(timeout=5)
        assert output is not None
        if provider == "chatgpt":
            assert output["decision"] == "block"
        else:
            assert output["hookSpecificOutput"]["hookEventName"] == "Stop"
        second = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="round two")
        next_token = waiting(child)
        assert next_token != token
        assert main(["loop", "feedback", child, "--wait-token", token, "--file", str(feedback)]) == 1
        assert event(tmp_path, provider, "lead", "Stop") is not None
        assert main(["loop", "release", child, "--wait-token", next_token]) == 0
        assert second.result(timeout=5) is None
    assert loop.lookup(child)["active"] is False
    capsys.readouterr()


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("interruption", ["Interrupt", "StopFailure", "UserPromptSubmit"])
def test_takeover_invalidates_verdict_and_next_stop_resumes(tmp_path, monkeypatch, provider, interruption):
    child = configured(tmp_path, monkeypatch, provider)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="before takeover")
        token = waiting(child)
        event(tmp_path, provider, child, interruption, prompt="Use the new requirement")
        assert first.result(timeout=5) is None
        with pytest.raises(sessions.SessionError):
            loop.respond(child, token, feedback="stale verdict")
        second = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="after takeover")
        next_token = waiting(child)
        assert next_token != token
        assert loop.lookup(child)["last_report"]["report"] == "after takeover"
        loop.respond(child, next_token)
        assert second.result(timeout=5) is None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("measurement", ["known", "missing", "malformed", "io-error", "unknown-window", "compacted"])
def test_report_usage_and_steering_are_delivered_and_persisted(tmp_path, monkeypatch, provider, measurement):
    child = configured(tmp_path, monkeypatch, provider)
    transcript = tmp_path / "transcript.jsonl"
    if provider == "claude":
        records = [{"type": "assistant", "uuid": "a", "message": {"model": "claude-opus-5-5" if measurement != "unknown-window" else "unvalidated", "usage": {"input_tokens": 500000}}}]
        if measurement == "compacted":
            records.append({"type": "system", "subtype": "compact_boundary", "uuid": "b", "parentUuid": "a"})
    else:
        records = [{"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"total_tokens": 61091}, "model_context_window": 258400 if measurement != "unknown-window" else None}}}]
        if measurement == "compacted":
            records.append({"type": "compacted", "payload": {}})
    if measurement == "io-error":
        transcript.mkdir()
    elif measurement != "missing":
        transcript.write_text("invalid\n" if measurement == "malformed" else "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    event(tmp_path, provider, "lead", "UserPromptSubmit", prompt="Lead steering")
    event(tmp_path, provider, child, "UserPromptSubmit", prompt="Implementer steering")
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="all results", transcript_path=str(transcript))
        token = waiting(child)
        info = loop.lookup(child)
        assert info["last_report"]["context_usage"] == info["context_usage"]
        if measurement == "known":
            assert info["context_usage"]["used_percentage"] == (50 if provider == "claude" else 20)
        else:
            assert info["context_usage"] is None
        assert [entry["message"] for entry in info["last_report"]["user_messages"]] == ["Lead steering", "Implementer steering"]
        assert event(tmp_path, provider, "lead", "Stop") is not None
        loop.respond(child, token)
        assert result.result(timeout=5) is None


def delivered_text(output):
    return output.get("reason") or output["hookSpecificOutput"]["additionalContext"]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_lead_receives_report_verbatim_with_its_wait_token(tmp_path, monkeypatch, provider):
    child = configured(tmp_path, monkeypatch, provider)
    report = '| Test | Result |\n| --- | --- |\n| "quoted" \\ path | pass |'
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message=report)
        token = waiting(child)
        try:
            text = delivered_text(event(tmp_path, provider, "lead", "Stop"))
        finally:
            loop.respond(child, token)
        assert result.result(timeout=5) is None
    assert report in text
    assert token in text


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_ship_lead_context_carries_its_session_and_explorer_inbox(tmp_path, monkeypatch, provider):
    configured(tmp_path, monkeypatch, provider)
    directory = ".claude" if provider == "claude" else ".agents"
    toolkit = tmp_path / directory / "skills" / "subagents-toolkit" / "SKILL.md"
    toolkit.parent.mkdir(parents=True)
    toolkit.touch()
    inbox = str(enable_delegation("lead", "ship").inbox)
    invocation = event(tmp_path, provider, "lead", "UserPromptSubmit", prompt="/ship 7" if provider == "claude" else "$ship 7")
    compacted = event(tmp_path, provider, "lead", "SessionStart", source="compact")
    for output in (invocation, compacted):
        assert "lead" in delivered_text(output) and inbox in delivered_text(output)


@pytest.mark.parametrize("side", ["lead", "implementer"])
@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_wait_limit_releases_only_after_implementer_stops(tmp_path, monkeypatch, provider, side):
    child = configured(tmp_path, monkeypatch, provider)
    (tmp_path / ".harness").mkdir()
    (tmp_path / ".harness/config.json").write_text('{"version":1,"session":{"stopWaitHours":0}}', encoding="utf-8")
    if side == "implementer":
        assert event(tmp_path, provider, child, "Stop", last_assistant_message="report") is None
    assert event(tmp_path, provider, "lead", "Stop") is not None
    assert loop.lookup(child)["active"] is (side == "lead")
    if side == "lead":
        inbox = enable_delegation("lead", "ship").inbox
        source = inbox / "replacement.md"
        source.write_text(
            f'---\nmode: loop\ncwd: {json.dumps(str(tmp_path))}\nprompt-file: {json.dumps(str(tmp_path / "prompt.md"))}\n---\nReplace.\n',
            encoding="utf-8",
        )
        launches = []
        rejected = process_inbox("lead", launch=lambda *_: launches.append(True), request_paths={source})
        assert rejected[0].status == "failed"
        assert launches == []
        # Expiry is terminal even if the implementer is steered before Stop.
        event(tmp_path, provider, child, "UserPromptSubmit", prompt="Finish safely")
        assert event(tmp_path, provider, child, "Stop", last_assistant_message="late report") is None
        assert loop.lookup(child)["active"] is False
        assert loop.lookup(child)["last_report"] is None
        assert loop.lookup(child)["wait"]["state"] == "expired"


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("reconcile_by_lookup", [False, True])
def test_expired_worktree_is_reusable_after_confirmed_process_exit(tmp_path, monkeypatch, provider, reconcile_by_lookup):
    child = configured(tmp_path, monkeypatch, provider)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        with sessions._connect() as db:
            db.execute("UPDATE executions SET provider_pid=?,provider_birth=? WHERE session_id=?",
                       (process.pid, processes.birth_identity(process.pid), child))
        (tmp_path / ".harness").mkdir()
        (tmp_path / ".harness/config.json").write_text('{"version":1,"session":{"stopWaitHours":0}}', encoding="utf-8")
        assert event(tmp_path, provider, "lead", "Stop") is not None
        assert loop.lookup(child)["active"] is True
        event(tmp_path, provider, "lead", "PreToolUse")
        loop.expire_parent_wait("lead")
        assert event(tmp_path, provider, "lead", "Stop") is None
        process.terminate()
        process.wait(timeout=5)
        if reconcile_by_lookup:
            assert loop.lookup(child)["active"] is False
        inbox = enable_delegation("lead", "ship").inbox
        source = inbox / "after-exit.md"
        source.write_text(
            f'---\nmode: loop\ncwd: {json.dumps(str(tmp_path))}\nprompt-file: {json.dumps(str(tmp_path / "prompt.md"))}\n---\nReplace.\n',
            encoding="utf-8",
        )
        result = process_inbox("lead", launch=lambda *_: "replacement-child", request_paths={source})[0]
        assert result.status == "launched", result.reason
        assert loop.lookup(child)["active"] is False
        assert loop.lookup(result.child_session_id)["active"] is True
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_killed_wait_rejects_feedback_without_provider_interrupt_event(tmp_path, monkeypatch, provider):
    child = configured(tmp_path, monkeypatch, provider)
    process = subprocess.Popen(
        [sys.executable, "-m", "subagents_runtime.hooks", "--" + provider],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", env={**os.environ, "PYTHONPATH": str(Path(loop.__file__).parents[1])},
    )
    try:
        process.stdin.write(json.dumps({"session_id": child, "cwd": str(tmp_path), "hook_event_name": "Stop", "last_assistant_message": "report"}))
        process.stdin.close()
        token = waiting(child)
        process.kill()
        process.wait(timeout=5)
        with pytest.raises(sessions.SessionError):
            loop.respond(child, token, feedback="obsolete verdict")
        assert loop.lookup(child)["wait"]["state"] == "taken-over"
        assert event(tmp_path, provider, "lead", "UserPromptSubmit", prompt="continue") is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_lead_interrupt_preserves_queued_report_for_next_prompt(tmp_path, monkeypatch, provider):
    child = configured(tmp_path, monkeypatch, provider)
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="saved report")
        token = waiting(child)
        assert event(tmp_path, provider, "lead", "Stop") is not None
        event(tmp_path, provider, "lead", "Interrupt")
        assert event(tmp_path, provider, "lead", "UserPromptSubmit", prompt="resume") is not None
        assert loop.lookup(child)["wait"]["token"] == token
        loop.respond(child, token)
        assert result.result(timeout=5) is None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_released_implementer_resumes_in_its_aboard_session(tmp_path, monkeypatch, capsys, provider):
    child = configured(tmp_path, monkeypatch, provider, difficulty="routine")
    with sessions._connect() as db:
        db.execute("UPDATE executions SET backend='aboard',aboard_agent_id='aboard-child',aboard_handle='terminal' WHERE session_id=?", (child,))
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="complete")
        loop.respond(child, waiting(child))
        assert result.result(timeout=5) is None
    monkeypatch.setenv("ABOARD_BRIDGE_PORT", "4823")
    monkeypatch.setenv("ABOARD_BRIDGE_TOKEN", "test-token")
    monkeypatch.setenv("HARNESS_SESSION_ID", "lead")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    requests = []
    def urlopen(request, timeout):
        requests.append(json.loads(request.data))
        return io.BytesIO(b'{"sessionId":"provider-child","agentId":"aboard-child","terminalId":"terminal"}')
    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    feedback = tmp_path / "review.md"
    feedback.write_text("Address review comments.", encoding="utf-8")
    assert main(["loop", "resume", child, "--file", str(feedback)]) == 0
    resumed = json.loads(capsys.readouterr().out)
    assert resumed["session_id"] == child
    assert resumed["provider_session_id"] == "provider-child"
    assert resumed["active"] is True
    assert requests[0]["resumeSessionId"] == "provider-child"
    assert requests[0]["difficulty"] == "routine"
    assert "forkSessionId" not in requests[0]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("ending", ["release", "expiry"])
def test_standalone_resume_requires_closed_terminal_and_keeps_conversation(tmp_path, monkeypatch, provider, ending):
    child = configured(tmp_path, monkeypatch, provider)
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="complete")
        token = waiting(child)
        if ending == "expiry":
            loop.expire_parent_wait("lead")
            with pytest.raises(sessions.SessionError):
                loop.respond(child, token, feedback="late verdict")
        else:
            loop.respond(child, token)
        assert result.result(timeout=5) is None
    with pytest.raises(sessions.SessionError, match="Standalone"):
        loop.resume(child, "Review fixes", parent_id="lead")
    assert loop.lookup(child)["active"] is False
    # Simulate the operating-system exit recorded by the existing supervisor.
    with sessions._connect() as db:
        db.execute("UPDATE executions SET state='exited' WHERE session_id=?", (child,))
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: tmp_path / "no-endpoints")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    config = tmp_path / ".harness/config.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"version": 1, "providers": {provider: {"command": [sys.executable]}}}), encoding="utf-8")
    launches = []
    def terminal(argv, environment, cwd):
        launches.append(json.loads(Path(argv[-1]).read_text(encoding="utf-8")))
        from subagents_runtime.processes import confirm_startup
        confirm_startup(environment["HARNESS_EXECUTION_ID"])
    monkeypatch.setattr(sessions, "_visible_terminal", terminal)
    result = loop.resume(child, "Review fixes", parent_id="lead")
    assert result["active"] is True
    assert result["provider_session_id"] == "provider-child"
    argv = launches[0]["argv"]
    assert "provider-child" in argv
    assert ("--resume" if provider == "claude" else "resume") in argv
    assert "fork" not in argv and "--fork-session" not in argv
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="resumed report")
        token = waiting(child)
        assert loop.lookup(child)["last_report"]["report"] == "resumed report"
        loop.respond(child, token)
        assert result.result(timeout=5) is None


def test_unavailable_aboard_does_not_duplicate_a_live_released_loop(tmp_path, monkeypatch):
    child = configured(tmp_path, monkeypatch, "claude")
    with sessions._connect() as db:
        db.execute("UPDATE executions SET backend='aboard',aboard_agent_id='aboard-child',aboard_handle='terminal' WHERE session_id=?", (child,))
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, "claude", child, "Stop", last_assistant_message="complete")
        loop.respond(child, waiting(child))
        result.result(timeout=5)
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: tmp_path / "no-endpoints")
    def terminal(*args):
        pytest.fail("a live conversation must not be opened a second time")
    monkeypatch.setattr(sessions, "_visible_terminal", terminal)
    with pytest.raises(sessions.SessionError):
        loop.resume(child, "Review fixes", parent_id="lead")
    assert loop.lookup(child)["active"] is False


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_new_lead_conversation_resumes_a_released_implementer(tmp_path, monkeypatch, provider):
    """/ship <PR> runs in a new Lead conversation; it takes over the released implementer and receives its reports."""
    child = configured(tmp_path, monkeypatch, provider)
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="needs a decision")
        loop.respond(child, waiting(child))
        assert result.result(timeout=5) is None
    with sessions._connect() as db:
        db.execute("UPDATE executions SET state='exited' WHERE session_id=?", (child,))
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: tmp_path / "no-endpoints")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    config = tmp_path / ".harness/config.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"version": 1, "providers": {provider: {"command": [sys.executable]}}}), encoding="utf-8")
    def terminal(argv, environment, cwd):
        from subagents_runtime.processes import confirm_startup
        confirm_startup(environment["HARNESS_EXECUTION_ID"])
    monkeypatch.setattr(sessions, "_visible_terminal", terminal)
    other = "claude" if provider == "chatgpt" else "chatgpt"
    sessions.register_observed("other-provider-lead", tmp_path, other)
    with pytest.raises(sessions.SessionError):
        loop.resume(child, "Apply the decision", parent_id="other-provider-lead")
    sessions.register_observed("pr-lead", tmp_path, provider)
    resumed = loop.resume(child, "Apply the decision", parent_id="pr-lead")
    assert resumed["session_id"] == child and resumed["active"] is True
    assert resumed["parent_session_id"] == "pr-lead"
    with ThreadPoolExecutor() as pool:
        result = pool.submit(event, tmp_path, provider, child, "Stop", last_assistant_message="decision applied")
        token = waiting(child)
        assert event(tmp_path, provider, "pr-lead", "Stop") is not None
        loop.respond(child, token, parent_id="pr-lead")
        assert result.result(timeout=5) is None
