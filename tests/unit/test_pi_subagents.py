import io
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from harness_cli.manifest import SupportStatus, discover
from subagents_runtime import pi_bridge, processes, progress, roles, sessions
from subagents_runtime.delegation import (
    RequestFileError,
    arm_reply,
    enable_delegation,
    parse_request_file,
    process_inbox,
    report_child_stop,
    results_marker,
)
from subagents_runtime.prompt_commands import sanitize_prompt_commands


@pytest.fixture
def project(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "home" / ".pi" / "agent"))
    for name in ("HARNESS_SESSION_ID", "HARNESS_EXECUTION_ID", "HARNESS_EXECUTION_MODE",
                 "HARNESS_PROVIDER", "HARNESS_PARENT_TERMINAL_URI", "ABOARD_BRIDGE_PORT", "ABOARD_BRIDGE_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, provider: [{"chatgpt": "codex"}.get(provider, provider)])
    authenticated_models(monkeypatch, MODELS)
    return project


# Pi's --list-models shows only models whose provider is authenticated.
MODELS = """provider   model                      context  max-out  thinking  images
anthropic  claude-haiku-4-5           200K     64K      yes       yes
anthropic  claude-haiku-4-5-20251001  200K     64K      yes       yes
anthropic  claude-haiku-5-5           1M       128K     yes       yes
openai     gpt-x                      1M       128K     yes       yes
openrouter gpt-x                      1M       128K     yes       yes
"""


def authenticated_models(monkeypatch, table: str) -> list[list[str]]:
    calls = []

    def run(argv, **_kwargs):
        calls.append(argv)
        assert argv[-2:] == ["--offline", "--list-models"]
        return subprocess.CompletedProcess(argv, 0, table, "")

    monkeypatch.setattr(sessions.subprocess, "run", run)
    return calls


@pytest.fixture
def launches(monkeypatch):
    recorded = []

    def start(execution_id, argv, environment, cwd, visible):
        recorded.append({"execution": execution_id, "argv": argv, "env": environment, "cwd": cwd, "visible": visible})

    monkeypatch.setattr(processes, "start", start)
    return recorded


def install_skill(root: Path, name: str) -> Path:
    skill = root / name / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
    if name == "subagents-toolkit":
        skill.with_name("builtin-tasks.yaml").write_bytes(
            roles.builtin_toolkit().with_name("builtin-tasks.yaml").read_bytes()
        )
    return skill


def request(project: Path, frontmatter: str, body: str = "Work.", parent: str = "parent"):
    inbox = enable_delegation(parent, "work-with-agent").inbox
    path = inbox / f"{uuid.uuid4().hex}.md"
    path.write_text(f"---\n{frontmatter}---\n{body}", encoding="utf-8")
    [result] = process_inbox(parent, launch=sessions.launch_delegated, request_paths={path})
    assert result.status == "launched", result.reason
    return result


def provider_session(session_id: str) -> str | None:
    with sessions._connect() as connection:
        return connection.execute("SELECT provider_session_id FROM sessions WHERE id=?", (session_id,)).fetchone()[0]


def request_row(request_id: str):
    with sessions._connect() as connection:
        return connection.execute("SELECT state,reply,reason FROM requests WHERE id=?", (request_id,)).fetchone()


def bridge(operation: str, **fields):
    return pi_bridge.handle({"version": 1, "operation": operation, **fields})


@pytest.mark.parametrize(("mode", "headless"), [("auto", True), ("interactive", False)])
def test_pi_child_launch_reserves_its_native_session_identity(project, launches, mode, headless):
    sessions.register_observed("parent", project, "pi")

    result = request(project, f"task: general\nmode: {mode}\n")

    child = result.child_session_id
    assert launches[-1]["argv"] == [
        "pi", "--name", "agent-1", *(["--mode", "json"] if headless else []),
        "--session-id", child, "--", "Work.",
    ]
    assert launches[-1]["visible"] is not headless
    assert launches[-1]["env"]["HARNESS_PROVIDER"] == "pi"
    assert provider_session(child) == child


def test_pi_child_skill_uses_a_space_separated_native_command(project, launches):
    install_skill(project / ".pi" / "skills", "prototype")
    sessions.register_observed("parent", project, "pi")

    request(project, "task: prototype\nmode: interactive\n", "Build it.")

    command, argument = launches[-1]["argv"][-1].split(" ", 1)
    assert command == "/skill:prototype"
    assert argument == "Build it."


def test_pi_child_skill_must_be_discoverable_by_pi(project, launches):
    install_skill(project / ".claude" / "skills", "prototype")
    sessions.register_observed("parent", project, "pi")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "work.md").write_text("---\ntask: prototype\nmode: interactive\n---\nBuild it.", encoding="utf-8")

    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "failed"
    assert launches == []


@pytest.mark.parametrize("live", [False, True])
def test_pi_continuation_reopens_or_forks_the_exact_session(project, launches, live):
    sessions.register_observed("parent", project, "pi")
    first = request(project, "task: general\nmode: auto\nmodel: openai/gpt-x\n")
    with sessions._connect() as connection:
        connection.execute("UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,))
        connection.execute(
            "UPDATE executions SET state=?,provider_pid=?,provider_birth=? WHERE request_id=?",
            ("running", os.getpid(), processes.birth_identity(os.getpid()), first.request_id) if live
            else ("exited", None, None, first.request_id),
        )

    request(project, "resume: agent-1\n", "Continue.")

    argv = launches[-1]["argv"]
    child = first.child_session_id
    assert "--name" not in argv
    assert argv[argv.index("--model") + 1] == "openai/gpt-x"
    if live:
        fork = argv[argv.index("--session-id") + 1]
        assert argv[argv.index("--fork") + 1] == child
        assert fork != child
        assert provider_session(child) == fork
    else:
        assert "--fork" not in argv
        assert argv[argv.index("--session-id") + 1] == child


@pytest.mark.parametrize(("profile", "expected"), [
    ({}, ["--thinking", "low"]),
    ({"model": "anthropic/claude-sonnet-5-5", "effort": "ultra"}, ["--model", "anthropic/claude-sonnet-5-5", "--thinking", "max"]),
    ({"effort": "none"}, ["--thinking", "off"]),
    ({"effort": "off"}, ["--thinking", "off"]),
    ({"model": "inherit", "effort": "inherit"}, []),
])
def test_pi_explore_profile_keeps_native_model_and_maps_thinking(profile, expected):
    config = {"version": 1, "providers": {"pi": {"delegations": {"explore": profile}}}}
    assert sessions.delegation_profile_arguments(config, "pi", "explore") == expected


@pytest.mark.parametrize(("pattern", "resolved"), [
    ("haiku", "anthropic/claude-haiku-5-5"),
    ("claude-haiku-4-5-20251001", "anthropic/claude-haiku-4-5-20251001"),
    ("Anthropic/HAIKU-4", "anthropic/claude-haiku-4-5"),
    ("openrouter/gpt-x", "openrouter/gpt-x"),
])
def test_pi_models_resolve_only_among_authenticated_providers(project, pattern, resolved):
    assert sessions.resolve_pi_model(["pi"], pattern, project) == resolved


@pytest.mark.parametrize(("table", "pattern", "error"), [
    (MODELS, "gpt-x", "ambiguous"),
    (MODELS, "bedrock-only-model", "no authenticated Pi model"),
    ('No models matching ""\n', "haiku", "no authenticated models"),
])
def test_unusable_pi_models_fail_before_launch(project, monkeypatch, table, pattern, error):
    authenticated_models(monkeypatch, table)
    with pytest.raises(sessions.SessionError, match=error):
        sessions.resolve_pi_model(["pi"], pattern, project)


def test_pi_child_launches_with_the_qualified_authenticated_model(project, launches):
    sessions.register_observed("parent", project, "pi")

    request(project, "task: general\nmode: auto\nmodel: haiku\n")

    argv = launches[-1]["argv"]
    assert argv[argv.index("--model") + 1] == "anthropic/claude-haiku-5-5"


def test_pi_child_with_an_unavailable_model_never_starts(project, launches):
    sessions.register_observed("parent", project, "pi")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    (inbox / "work.md").write_text("---\ntask: general\nmode: auto\nmodel: bedrock-only-model\n---\nWork.", encoding="utf-8")

    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "failed" and "no authenticated Pi model" in result.reason
    assert launches == []


def test_pi_profiles_reject_difficulty_routing():
    config = {"version": 1, "providers": {"pi": {"delegations": {"general": {"model": "by-difficulty"}}}}}
    with pytest.raises(sessions.SessionError):
        sessions.delegation_profile_arguments(config, "pi", "general")


def test_pi_children_receive_plain_file_paths(project, launches):
    sessions.register_observed("parent", project, "pi")

    request(project, "task: general\nmode: auto\n", "Inspect @src/core.py and /new ideas.")

    assert launches[-1]["argv"][-1] == f"Inspect {os.sep.join(['src', 'core.py'])} and new ideas."


def test_pi_prompt_sanitizer_keeps_skill_commands():
    assert sanitize_prompt_commands("/tree then /skill:review-this", "pi") == "tree then /skill:review-this"


def test_pi_loop_implementers_are_rejected(project):
    sessions.register_observed("parent", project, "pi")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    prompt = project / "prompt.md"
    prompt.write_text("Implement.", encoding="utf-8")
    path = inbox / "loop.md"
    path.write_text(f"---\ntask: loop\nmode: loop\ncwd: {project}\nprompt-file: {prompt}\n---\nImplement.", encoding="utf-8")

    with pytest.raises(RequestFileError, match="pi"):
        parse_request_file(path, inbox, parent_provider="pi", cwd=project)


def test_pi_skills_are_found_where_pi_discovers_them(project, monkeypatch):
    nested = project / "packages" / "app"
    nested.mkdir(parents=True)
    install_skill(project / ".pi" / "skills", "only-at-root")
    install_skill(project / ".agents" / "skills", "agent-skill")
    install_skill(Path(os.environ["PI_CODING_AGENT_DIR"]) / "skills", "user-skill")

    assert roles.find_skill(nested, "pi", "only-at-root") is None
    assert roles.find_skill(project, "pi", "only-at-root") is not None
    assert roles.find_skill(nested, "pi", "agent-skill") is not None
    assert roles.find_skill(nested, "pi", "user-skill") is not None
    assert roles.find_skill(nested, "claude", "user-skill") is None


def assistant(text="Done.", stop="stop", **extra):
    return {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "stopReason": stop, **extra}}


@pytest.mark.parametrize(("events", "code", "success", "reason"), [
    ([assistant(), {"type": "agent_settled", "aborted": False}], 0, True, None),
    ([assistant("Partial", "error", errorMessage="529 overloaded"), {"type": "agent_settled", "aborted": False}], 0, False, "Pi response failed: 529 overloaded"),
    ([assistant("Partial", "length"), {"type": "agent_settled", "aborted": False}], 0, False, "Pi response reached the output token limit"),
    ([assistant("Partial", "aborted"), {"type": "agent_settled", "aborted": True}], 0, False, "Pi run was aborted"),
    ([assistant()], 0, False, "Pi exited before its run settled"),
    ([assistant(" "), {"type": "agent_settled", "aborted": False}], 0, False, "Pi finished without a final response"),
    ([assistant(), {"type": "agent_settled", "aborted": False}], 3, False, "Pi exited with code 3"),
])
def test_pi_run_success_requires_a_settled_final_answer(events, code, success, reason):
    run = processes.PiRun()
    for event in events:
        run.observe(event)

    _text, succeeded, why = run.outcome(code)

    assert (succeeded, why) == (success, reason)


def test_pi_run_keeps_only_the_final_assistant_message():
    run = processes.PiRun()
    assert run.observe({"type": "session", "version": 3, "id": "native"}) == "native"
    for event in (assistant("First."), assistant("Final."), {"type": "agent_settled", "aborted": False}):
        run.observe(event)

    assert run.outcome(0) == ("Final.", True, None)


@pytest.mark.parametrize("failed", [False, True])
def test_supervisor_reports_a_real_pi_json_stream(project, launches, tmp_path, failed):
    sessions.register_observed("parent", project, "pi")
    result = request(project, "task: general\nmode: auto\n")
    launch = launches[-1]
    events = [
        {"type": "session", "version": 3, "id": result.child_session_id, "cwd": str(project)},
        assistant("Partial", "error", errorMessage="boom") if failed else assistant("Answer."),
        {"type": "agent_settled", "aborted": False},
    ]
    stream = tmp_path / "events.jsonl"
    stream.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
    script = tmp_path / "fake_pi.py"
    script.write_text("import sys\nsys.stdout.write(open(sys.argv[1], encoding='utf-8').read())\n", encoding="utf-8")
    specification = tmp_path / "launch.json"
    specification.write_text(json.dumps({
        "argv": [sys.executable, str(script), str(stream)], "environment": launch["env"],
        "cwd": str(project), "visible": False,
    }), encoding="utf-8")
    marker = results_marker("parent")

    assert processes.supervise(launch["execution"], specification) == 0

    state, reply, reason = request_row(result.request_id)
    assert (state, reply, reason) == (("failed", None, "Pi response failed: boom") if failed else ("succeeded", "Answer.", None))
    assert marker.is_file()


def test_pi_watch_summarizes_native_events():
    summaries = [progress.event_summary(event) for event in (
        {"type": "session", "id": "native"},
        {"type": "tool_execution_start", "toolName": "bash", "args": {"command": "pytest -q"}},
        assistant("All tests pass."),
        assistant("", "error", errorMessage="rate limited"),
        {"type": "agent_settled", "aborted": False},
    )]
    assert all(summaries)
    assert len(set(summaries)) == len(summaries)


def test_pi_children_route_through_aboard_when_it_is_running(project, monkeypatch):
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda *_args, **_kwargs: ("127.0.0.1", 4823, "token"))
    bodies = []

    def urlopen(http_request, timeout):
        bodies.append(json.loads(http_request.data))
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-pi-session"}')

    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(processes, "start", lambda *_args, **_kwargs: pytest.fail("native launch used"))
    sessions.register_observed("parent", project, "pi")

    result = request(project, "task: general\nmode: auto\n")

    assert bodies[0]["provider"] == "pi"
    assert provider_session(result.child_session_id) == "aboard-pi-session"


class TestBridge:
    def test_session_start_assigns_an_inbox_only_with_the_toolkit(self, project):
        plain = bridge("session_start", cwd=str(project), sessionId="plain", reason="startup")
        assert plain["ok"] and plain["inbox"] is None and plain["instructions"] is None

        install_skill(project / ".pi" / "skills", "subagents-toolkit")
        started = bridge("session_start", cwd=str(project), sessionId="native", reason="startup")
        reloaded = bridge("session_start", cwd=str(project), sessionId="native", reason="reload")

        assert started["ok"], started
        assert started["inbox"] and Path(started["inbox"]).is_dir() and started["instructions"]
        assert reloaded["harnessSessionId"] == started["harnessSessionId"]
        assert reloaded["inbox"] == started["inbox"]
        assert started["delegatedMode"] is None

    def test_new_and_fork_sessions_are_unrelated_conversations(self, project, launches, monkeypatch):
        sessions.register_observed("parent", project, "pi")
        child = request(project, "task: general\nmode: interactive\n").child_session_id
        monkeypatch.setenv("HARNESS_SESSION_ID", child)
        monkeypatch.setenv("HARNESS_EXECUTION_MODE", "interactive")

        bound = bridge("session_start", cwd=str(project), sessionId=child, reason="startup")
        forked = bridge("session_start", cwd=str(project), sessionId="user-fork", reason="fork")

        assert (bound["harnessSessionId"], bound["delegatedMode"]) == (child, "interactive")
        assert forked["harnessSessionId"] == "user-fork"
        assert forked["delegatedMode"] is None

    def test_delegation_skill_supplies_inbox_instructions(self, project):
        sessions.register_observed("parent", project, "pi")

        invoked = bridge("prompt", harnessSessionId="parent", text="/skill:work-with-agent review the parser")
        plain = bridge("prompt", harnessSessionId="parent", text="Explain /skill:unknown-with-agent")

        assert invoked["ok"] and invoked["context"]
        assert plain["ok"] and plain["context"] is None

    def test_inbox_write_launches_only_requests_in_the_owned_inbox(self, project, launches):
        sessions.register_observed("parent", project, "pi")
        inbox = enable_delegation("parent", "work-with-agent").inbox
        outside = project / "notes.md"
        outside.write_text("---\ntask: general\nmode: auto\n---\nWork.", encoding="utf-8")
        inside = inbox / "work.md"
        inside.write_text("---\ntask: general\nmode: auto\n---\nWork.", encoding="utf-8")

        ignored = bridge("inbox_write", harnessSessionId="parent", paths=[str(outside)])
        launched = bridge("inbox_write", harnessSessionId="parent", paths=[str(inside)])

        assert ignored["ok"] and ignored["context"] is None
        assert launched["ok"] and launched["context"]
        assert len(launches) == 1

    def test_results_replay_until_acknowledged(self, project, launches):
        sessions.register_observed("parent", project, "pi")
        child = request(project, "task: general\nmode: auto\n")
        marker = results_marker("parent")
        assert bridge("claim_delivery", harnessSessionId="parent")["pending"] is True

        report_child_stop(child.child_session_id, "Answer.", success=True)
        first = bridge("claim_delivery", harnessSessionId="parent")
        replay = bridge("claim_delivery", harnessSessionId="parent")
        acknowledged = bridge("ack_delivery", harnessSessionId="parent", deliveryId=first["delivery"]["id"])
        after = bridge("claim_delivery", harnessSessionId="parent")

        assert marker.is_file()
        assert first["delivery"] and replay["delivery"]["id"] == first["delivery"]["id"]
        assert acknowledged["acknowledged"] is True
        assert after["delivery"] is None and after["pending"] is False

    @pytest.fixture
    def interactive_child(self, project, launches, monkeypatch):
        sessions.register_observed("parent", project, "pi")
        result = request(project, "task: general\nmode: interactive\n")
        monkeypatch.setenv("HARNESS_SESSION_ID", result.child_session_id)
        monkeypatch.setenv("HARNESS_EXECUTION_ID", launches[-1]["execution"])
        monkeypatch.setenv("HARNESS_EXECUTION_MODE", "interactive")
        bridge("session_start", cwd=str(project), sessionId=result.child_session_id, reason="startup")
        return result

    def test_armed_reply_is_sent_once_after_a_successful_turn(self, interactive_child):
        child = interactive_child.child_session_id
        unarmed = bridge("settled", harnessSessionId=child, success=True, message="Not yet.")
        armed = bridge("prompt", harnessSessionId=child, text="/skill:reply-to-agent")
        failed = bridge("settled", harnessSessionId=child, success=False, message="", reason="Pi turn was aborted")
        assert request_row(interactive_child.request_id)[0] == "pending"
        bridge("prompt", harnessSessionId=child, text="/skill:reply-to-agent")
        replied = bridge("settled", harnessSessionId=child, success=True, message="Conclusion.")

        assert unarmed["reported"] is False
        assert armed["notice"] and failed["reported"] is False
        assert replied["reported"] is True
        assert request_row(interactive_child.request_id)[:2] == ("succeeded", "Conclusion.")

    def test_a_new_prompt_expires_an_armed_reply(self, interactive_child):
        child = interactive_child.child_session_id
        bridge("prompt", harnessSessionId=child, text="/skill:reply-to-agent")
        bridge("prompt", harnessSessionId=child, text="One more change first.")

        assert bridge("settled", harnessSessionId=child, success=True, message="Changed.")["reported"] is False

    def test_previous_message_reply_completes_the_request_without_a_turn(self, interactive_child):
        replied = bridge("previous_reply", harnessSessionId=interactive_child.child_session_id, message="Earlier answer.")

        assert replied["ok"] and replied["notice"]
        assert request_row(interactive_child.request_id)[:2] == ("succeeded", "Earlier answer.")

    def test_closing_an_interactive_child_cancels_its_request(self, interactive_child):
        bridge("shutdown", harnessSessionId=interactive_child.child_session_id)

        assert request_row(interactive_child.request_id)[0] == "cancelled"

    def test_reply_outside_a_delegated_child_is_an_error(self, project):
        sessions.register_observed("solo", project, "pi")
        install_skill(project / ".pi" / "skills", "subagents-toolkit")

        result = bridge("prompt", harnessSessionId="solo", text="/skill:reply-to-agent")

        assert result["ok"] is False and result["error"]

    @pytest.mark.parametrize("payload", [
        {"version": 2, "operation": "claim_delivery"},
        {"version": 1, "operation": "missing"},
        {"version": 1, "operation": "claim_delivery", "harnessSessionId": "unknown"},
        [],
    ])
    def test_invalid_requests_receive_protocol_errors(self, project, payload):
        result = pi_bridge.handle(payload)
        assert result["version"] == 1 and result["ok"] is False and result["error"]

    def test_bridge_refuses_sessions_of_other_providers(self, project):
        sessions.register_observed("claude-parent", project, "claude")
        result = bridge("claim_delivery", harnessSessionId="claude-parent")
        assert result["ok"] is False


def test_catalogue_installs_the_pi_extension_with_shared_skills():
    tool = discover()["subagents"]
    entries = {entry.dest: entry for entry in tool.expand("pi")}

    assert tool.support_for("pi").status is SupportStatus.SUPPORTED
    assert entries[".harness-subagents/index.ts"].root == "extensions"
    assert "subagents-toolkit/SKILL.md" in entries
    assert not any(dest.endswith("openai.yaml") for dest in entries)
    transport = next(dependency for dependency in tool.dependencies if dependency.name == "pi-transport")
    assert [platform.value for platform in transport.platforms] == ["pi"]
    assert transport.lifecycle == "coupled"
    for dependency in ("prototype", "websearch", "grill-me", "issue-readers"):
        assert discover()[dependency].support_for("pi").status is SupportStatus.SUPPORTED
