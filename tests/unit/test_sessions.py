import io
import json
import os
import re
import urllib.error
from pathlib import Path

import pytest

pytestmark = pytest.mark.usefixtures("loaded_subagents_integration")

from subagents_runtime import sessions, bridge_backend
from subagents_runtime.cli import build_parser


def reserve_bridge_request(project, monkeypatch):
    from subagents_runtime import processes
    sessions.register_observed("parent", project, "claude")
    with sessions._connect() as db:
        db.execute("INSERT INTO sessions(id,cwd,parent_session_id,agent_index) VALUES ('child',?,'parent',1)", (str(project),))
        db.execute("INSERT INTO requests(id,parent_session_id,child_session_id,state) VALUES ('request','parent','child','launching')")
        db.execute("INSERT INTO executions(id,session_id,request_id,backend,state) VALUES ('execution','child','request','bridge','prepared')")
    monkeypatch.setattr(processes, "confirm_startup", lambda *_: None)


def configured(tmp_path, monkeypatch, launches):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    from subagents_runtime import processes
    def start(execution_id,argv,environment,cwd,visible):
        launches.append((argv,environment,cwd))
        from subagents_runtime.reply_support import _write
        from subagents_runtime.storage import state_dir

        _write(state_dir() / "runtime/reply-ready" / execution_id, environment["HARNESS_PROVIDER"].encode())
        processes.confirm_startup(execution_id)
    monkeypatch.setattr(processes,"start",start)
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: launches.append((argv, environment, cwd)))
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: ["claude"])


def test_resume_uses_registered_provider_session(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    session_id = sessions.launch(provider="claude")
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET state='exited' WHERE session_id=?",(session_id,))
    sessions.resume(session_id)
    assert launches[-1][0] == ["claude", "--resume", session_id]
    assert launches[-1][1]["HARNESS_SESSION_ID"] == session_id


def test_shell_command_builders_preserve_spaces_quotes_and_harness_identity():
    argv = ["C:\\Program Files\\Claude\\claude.exe", "say 'hello'", 'and "goodbye"']
    assert sessions._powershell_command(argv) == "& 'C:\\Program Files\\Claude\\claude.exe' 'say ''hello''' 'and \"goodbye\"'"
    mac = sessions._macos_terminal_command(
        ["claude", "a prompt with spaces"],
        {"PATH": "/bin", "HARNESS_SESSION_ID": "session 1", "HARNESS_REQUEST_ID": "request-1"},
        Path("/tmp/a project"),
    )
    assert "HARNESS_SESSION_ID=session 1" in mac
    assert "HARNESS_REQUEST_ID=request-1" in mac
    assert "PATH=" not in mac


def test_array_commands_are_argv_and_preserve_token_contents():
    assert sessions._command(["wrapper", " profile with spaces "], "terminalCommand") == ["wrapper", " profile with spaces "]


@pytest.mark.parametrize("provider, model", [("claude", "claude-opus-5-5"), ("chatgpt", "gpt-6.1-sol")])
@pytest.mark.parametrize("mode", ["interactive", "auto"])
@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("effort", [None, "ultra"])
def test_delegated_model_overrides_only_when_requested(tmp_path, monkeypatch, provider, model, mode, explicit, effort):
    from subagents_runtime.delegation import enable_delegation, process_inbox

    launches = []
    configured(tmp_path / "state", monkeypatch, launches)
    monkeypatch.setattr(bridge_backend, "discover", lambda _: None)
    (tmp_path / ".harness").mkdir()
    (tmp_path / ".harness" / "config.json").write_text(json.dumps({
        "version": 1,
        "providers": {provider: {"delegations": {"general": {
            "model": "sonnet" if provider == "claude" else "gpt-5.6-luna", "effort": "high",
        }}}},
    }), encoding="utf-8")
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    model_field = f"model: {model}\n" if explicit else ""
    if effort is not None:
        model_field += f"effort: {effort}\n"
    (inbox / "work.md").write_text(f"---\nmode: {mode}\n{model_field}---\nWork.", encoding="utf-8")

    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "launched", result.reason
    argv = launches[-1][0]
    assert argv.count("--model") == 1
    assert argv[argv.index("--model") + 1] == (model if explicit else "sonnet" if provider == "claude" else "gpt-5.6-luna")
    if provider == "claude":
        assert argv[argv.index("--effort") + 1] == ("max" if effort else "high")
    else:
        effective = ("ultra" if explicit else "max") if effort else "high"
        assert f'model_reasoning_effort="{effective}"' in argv


@pytest.mark.parametrize("provider, model", [("claude", "claude-opus-5-5"), ("chatgpt", "gpt-6.1-sol")])
@pytest.mark.parametrize("live", [False, True])
def test_delegated_resume_retains_explicit_model(tmp_path, monkeypatch, provider, model, live):
    import os
    from subagents_runtime import processes
    from subagents_runtime.delegation import enable_delegation, process_inbox

    launches = []
    configured(tmp_path / "state", monkeypatch, launches)
    monkeypatch.setattr(bridge_backend, "discover", lambda _: None)
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text(f"---\nmode: auto\nmodel: {model}\n---\nWork.", encoding="utf-8")
    [first] = process_inbox("parent", launch=sessions.launch_delegated)
    assert first.status == "launched", first.reason
    with sessions._connect() as connection:
        connection.execute("UPDATE sessions SET provider_session_id='provider-child' WHERE id=?", (first.child_session_id,))
        connection.execute("UPDATE executions SET state='exited' WHERE request_id=?", (first.request_id,))
        connection.execute("UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,))
        if live:
            connection.execute("UPDATE executions SET state='running',provider_pid=?,provider_birth=? WHERE request_id=?",
                               (os.getpid(), processes.birth_identity(os.getpid()), first.request_id))
    (inbox / "continue.md").write_text("---\nresume: agent-1\n---\nContinue.", encoding="utf-8")

    [continued] = process_inbox("parent", launch=sessions.launch_delegated)

    assert continued.status == "launched", continued.reason
    argv = launches[-1][0]
    assert argv[argv.index("--model") + 1] == model
    if live:
        assert "--fork-session" in argv if provider == "claude" else "fork" in argv


@pytest.mark.parametrize("model", [None, "gpt-6.1-sol"])
@pytest.mark.parametrize("effort", [None, "ultra"])
def test_delegated_launch_prefers_the_scoped_aboard_endpoint(tmp_path, monkeypatch, model, effort):
    monkeypatch.setenv("HARNESS_STATE_DIR",str(tmp_path / "state"))
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(
        bridge_backend,
        "discover",
        lambda _cwd: ("127.0.0.1", 4823, "scoped-secret"),
    )
    captured = {}

    def urlopen(request, timeout):
        captured["authorization"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.data)
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-child"}')

    monkeypatch.setattr(bridge_backend.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: pytest.fail("native fallback used"))
    request = type("Request", (), {"task": "general", "child_skill": "prototype", "resume": None, "provider": "chatgpt", "mode": "auto", "prompt": "Build it.", "model": model, "effort": effort})()
    reserve_bridge_request(project, monkeypatch)
    backend = bridge_backend.BridgeBackend()
    assert backend.probe(request, project)
    assert backend.launch(request, "request", 1, project) == "child"
    assert captured["authorization"] == "Bearer scoped-secret"
    assert captured["body"]["requestId"] == "request"
    assert "task" not in captured["body"]
    assert captured["body"]["skill"] == "prototype"
    assert captured["body"]["cwd"] == str(project.resolve())
    assert captured["body"].get("model") == model
    assert ("model" in captured["body"]) == (model is not None)
    assert captured["body"].get("effort") == effort
    assert ("effort" in captured["body"]) == (effort is not None)


def test_existing_database_keeps_children_when_model_selection_is_added(tmp_path, monkeypatch):
    from subagents_runtime.delegation import enable_delegation, process_inbox

    launches = []
    configured(tmp_path / "state", monkeypatch, launches)
    monkeypatch.setattr(bridge_backend, "discover", lambda _: None)
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "old.md").write_text("---\nmode: auto\n---\nWork.", encoding="utf-8")
    [original] = process_inbox("parent", launch=sessions.launch_delegated)
    assert original.status == "launched", original.reason
    with sessions._connect() as connection:
        connection.execute("ALTER TABLE sessions DROP COLUMN model")
        connection.execute("PRAGMA user_version=6")
    (inbox / "new.md").write_text("---\nmode: auto\nmodel: claude-opus-5-5\n---\nWork.", encoding="utf-8")

    [new] = process_inbox("parent", launch=sessions.launch_delegated)

    assert new.status == "launched", new.reason
    assert sessions.resolve_session("agent-1", "parent") == original.child_session_id
    argv = launches[-1][0]
    assert argv[argv.index("--model") + 1] == "claude-opus-5-5"


@pytest.mark.parametrize("provider", ["claude","chatgpt"])
@pytest.mark.parametrize("mode", ["interactive","auto"])
def test_native_provider_adapter_uses_reserved_id_mode_and_cwd(provider,mode,tmp_path,monkeypatch):
    launches = []
    configured(tmp_path / "state",monkeypatch,launches)
    monkeypatch.setattr(bridge_backend,"discover",lambda _: None)
    from subagents_runtime.delegation import enable_delegation,process_inbox
    sessions.register_observed("parent",tmp_path,provider)
    inbox = enable_delegation("parent","subagents-toolkit").inbox
    source = inbox / "work.md"
    source.write_text(f"---\nmode: {mode}\n---\nWork.",encoding="utf-8")
    [result] = process_inbox("parent",launch=sessions.launch_delegated)
    assert result.status == "launched"
    assert launches[-1][1]['HARNESS_SESSION_ID'] == result.child_session_id
    assert launches[-1][1]['HARNESS_EXECUTION_MODE'] == mode
    assert launches[-1][2] == tmp_path.resolve()
    if mode == 'auto':
        assert ('-p' in launches[-1][0]) if provider == 'claude' else ('exec' in launches[-1][0])


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("backend", ["standalone", "aboard"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_file_reference_conversion_reaches_both_launch_backends(
    provider, backend, mode, tmp_path, monkeypatch
):
    from subagents_runtime.delegation import enable_delegation, process_inbox

    launches = []
    configured(tmp_path / "state", monkeypatch, launches)
    monkeypatch.setattr(
        bridge_backend, "discover",
        lambda _: ("127.0.0.1", 4823, "token") if backend == "aboard" else None,
    )
    bodies = []

    def urlopen(request, timeout):
        bodies.append(json.loads(request.data))
        from subagents_runtime.reply_support import _write
        from subagents_runtime.storage import state_dir

        _write(state_dir() / "runtime/reply-ready" / bodies[-1]["executionId"], provider.encode())
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-child"}')

    monkeypatch.setattr(bridge_backend.urllib.request, "urlopen", urlopen)
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text(
        f"---\nmode: {mode}\n---\n" + r"Inspect @src\core.py.",
        encoding="utf-8",
    )

    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "launched", result.reason
    delivered = bodies[0]["prompt"] if backend == "aboard" else launches[0][0][-1]
    references = re.findall(r"(@?)(src[/\\]core\.py)", delivered)
    assert references == (
        [("@", r"src\core.py")] if provider == "claude" else [("", os.sep.join(["src", "core.py"]))]
    )


def test_interactive_claude_child_does_not_inherit_nested_session_marker(
    tmp_path, monkeypatch
):
    launches = []
    configured(tmp_path / "state", monkeypatch, launches)
    monkeypatch.setattr(bridge_backend, "discover", lambda _: None)
    monkeypatch.setenv("CLAUDE_CODE_CHILD_SESSION", "1")
    from subagents_runtime.delegation import enable_delegation, process_inbox

    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text(
        "---\nmode: interactive\n---\nWork.", encoding="utf-8"
    )

    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "launched"
    assert "CLAUDE_CODE_CHILD_SESSION" not in launches[-1][1]


def test_scoped_aboard_launch_refreshes_endpoint_after_unauthorized_response(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR",str(tmp_path / "state"))
    endpoints = iter([
        ("127.0.0.1", 4823, "expired"),
        ("127.0.0.1", 4923, "fresh"),
    ])
    monkeypatch.setattr(bridge_backend, "discover", lambda _cwd: next(endpoints))
    calls = []

    def urlopen(request, timeout):
        calls.append((request.full_url, request.headers["Authorization"]))
        if len(calls) == 1:
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-child"}')

    monkeypatch.setattr(bridge_backend.urllib.request, "urlopen", urlopen)
    request = type("Request", (), {"task": "general", "resume": None, "provider": "claude", "mode": "auto", "prompt": "Do it."})()
    reserve_bridge_request(tmp_path, monkeypatch)
    backend = bridge_backend.BridgeBackend()
    assert backend.probe(request, tmp_path)
    assert backend.launch(request, "request", 1, tmp_path) == "child"
    assert calls == [
        ("http://127.0.0.1:4823/delegations", "Bearer expired"),
        ("http://127.0.0.1:4923/delegations", "Bearer fresh"),
    ]


def test_cli_requires_an_explicit_run_provider_and_keeps_other_commands_narrow():
    parser = build_parser()
    assert parser.parse_args(["run", "--provider", "claude"]).provider == "claude"
    assert parser.parse_args(["run", "--provider", "chatgpt"]).provider == "chatgpt"
    with pytest.raises(SystemExit):
        parser.parse_args(["run"])
    assert parser.parse_args(["ask", "session-123"]).session_id == "session-123"
    assert parser.parse_args(["reply"]).command == "reply"
    with pytest.raises(SystemExit):
        parser.parse_args(["reply", "embedded answer"])


def test_runtime_assigned_chatgpt_identity_binds_for_resume(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, provider="claude": ["codex" if provider == "chatgpt" else "claude"])
    stable = sessions.launch(provider="chatgpt", cwd=tmp_path)
    monkeypatch.setenv("HARNESS_SESSION_ID", stable)

    assert sessions.bind_observed("runtime-codex-id", tmp_path, "chatgpt") == stable
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET state='exited' WHERE session_id=?",(stable,))
    sessions.resume(stable)

    assert launches[-1][0] == ["codex", "resume", "runtime-codex-id"]


def test_endpoint_discovery_rejects_dead_processes_and_incomplete_fleet_auth(tmp_path, monkeypatch):
    endpoint = tmp_path / "endpoints"
    endpoint.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    (endpoint / "dead.json").write_text(json.dumps({
        "version": 2, "host": "127.0.0.1", "port": 4823,
        "workspaceRoot": str(project), "delegationToken": "secret",
        "pid": 999_999_999, "activatedAt": "2026-09-10T10:00:00Z",
    }), encoding="utf-8")
    monkeypatch.setattr(bridge_backend, "endpoint_directory", lambda: endpoint)
    assert bridge_backend.discover(project) is None

    monkeypatch.setenv("HARNESS_BRIDGE_PORT", "4823")
    monkeypatch.delenv("HARNESS_BRIDGE_TOKEN", raising=False)
    with pytest.raises(sessions.SessionError, match="incomplete"):
        bridge_backend.discover(project)


def test_launch_configuration_resolves_project_then_global_then_defaults(tmp_path, monkeypatch):
    state = tmp_path / "state"
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    monkeypatch.setattr(sessions.shutil, "which", lambda command: command)

    assert sessions.launch_configuration(project) == {"version": 1}
    state.mkdir()
    (state / "config.json").write_text(
        '{"version":1,"autoRun":{"provider":"claude"},"providers":{"claude":{},"chatgpt":{"command":["global-codex"]}}}', encoding="utf-8"
    )
    assert sessions._provider_command(sessions.launch_configuration(project), "chatgpt") == ["global-codex"]

    (project / ".harness").mkdir()
    (project / ".harness" / "config.json").write_text(
        '{"version":1,"autoRun":{"provider":"claude"},"providers":{"claude":{"command":["project-claude"]},"chatgpt":{}}}', encoding="utf-8"
    )
    assert sessions._provider_command(sessions.launch_configuration(project), "claude") == ["project-claude"]
    assert sessions._provider_command(sessions.launch_configuration(project), "chatgpt") == ["codex"]


def test_launch_configuration_validates_sparse_provider_and_session_shapes(tmp_path, monkeypatch):
    project = tmp_path / "project"
    launch = project / ".harness" / "config.json"
    launch.parent.mkdir(parents=True)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    for value in (
        {"version": 2, "platform": "claude"},
        {"version": 1, "providers": {"claude": []}},
        {"version": 1, "autoRun": {"provider": "claude"}, "providers": {"claude": {}, "chatgpt": {}}, "session": {"stopWaitHours": -1}},
    ):
        launch.write_text(json.dumps(value), encoding="utf-8")
        with pytest.raises(sessions.SessionError):
            sessions.launch_configuration(project)

    launch.write_text(json.dumps({
        "version": 1,
        "autoRun": {"provider": "claude"},
        "providers": {"claude": {}, "chatgpt": {}},
        "session": {"stopWaitHours": 1.5},
    }), encoding="utf-8")
    assert sessions.launch_configuration(project)["session"]["stopWaitHours"] == 1.5


@pytest.mark.parametrize("auto_run", [None, [], {"provider": "unknown"}])
def test_launch_configuration_ignores_aboard_auto_run_settings(tmp_path, monkeypatch, auto_run):
    launch = tmp_path / ".harness" / "config.json"
    launch.parent.mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    launch.write_text(json.dumps({
        "version": 1,
        "autoRun": auto_run,
        "providers": {"claude": {"delegations": {"general": {"model": "claude-opus-5-5"}}}},
    }), encoding="utf-8")

    config = sessions.launch_configuration(tmp_path)
    assert sessions.delegation_profile_arguments(config, "claude", "general") == [
        "--model", "claude-opus-5-5",
    ]


def test_standalone_delegation_profiles_use_task_defaults_and_sparse_overrides():
    sparse = {"version": 1}
    assert sessions.delegation_profile_arguments(sparse, "chatgpt", "explore") == [
        "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="low"'
    ]
    assert sessions.delegation_profile_arguments(sparse, "chatgpt", "prototype") == []
    configured = {
        "version": 1,
        "providers": {"claude": {"delegations": {"review": {"model": "opus", "effort": "high"}}}},
    }
    assert sessions.delegation_profile_arguments(configured, "claude", "review") == [
        "--model", "opus", "--effort", "high"
    ]


def test_standalone_claude_delegation_profile_applies_tool_denials():
    configured = {
        "version": 1,
        "providers": {
            "claude": {
                "delegations": {
                    "review": {"deniedTools": ["Agent", "WebSearch", "Agent"]}
                }
            }
        },
    }

    assert sessions.delegation_profile_arguments(
        configured, "claude", "review"
    ) == ["--disallowedTools", "Agent,WebSearch"]


@pytest.mark.parametrize(
    ("provider", "profile"),
    [
        ("claude", {"model": "gpt-5.6-sol"}),
        ("claude", {"effort": "invalid"}),
        ("chatgpt", {"model": "opus"}),
        ("chatgpt", {"effort": "invalid"}),
    ],
)
def test_standalone_delegation_profiles_reject_provider_invalid_values(
    provider, profile
):
    configured = {
        "version": 1,
        "providers": {provider: {"delegations": {"review": profile}}},
    }

    with pytest.raises(sessions.SessionError):
        sessions.delegation_profile_arguments(configured, provider, "review")
