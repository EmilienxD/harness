import io
import json
import urllib.error
from pathlib import Path

import pytest

from subagents_runtime import sessions
from subagents_runtime.cli import build_parser


def configured(tmp_path, monkeypatch, launches):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: launches.append((argv, environment, cwd)))
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config: ["claude"])


def test_resume_uses_registered_provider_session(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    session_id = sessions.launch()
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


def test_delegated_launch_prefers_the_scoped_aboard_endpoint(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(
        sessions,
        "_discover_delegation_endpoint",
        lambda _cwd: ("127.0.0.1", 4823, "scoped-secret"),
    )
    captured = {}

    def urlopen(request, timeout):
        captured["authorization"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.data)
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-child"}')

    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: pytest.fail("native fallback used"))
    request = type("Request", (), {"task": "prototype", "provider": "chatgpt", "mode": "auto", "prompt": "Build it."})()
    assert sessions.launch_delegated(request, "request", 1, project) == "aboard-child"
    assert captured["authorization"] == "Bearer scoped-secret"
    assert captured["body"]["requestId"] == "request"
    assert captured["body"]["cwd"] == str(project.resolve())


@pytest.mark.parametrize(("task", "skill"), [
    ("websearch", "websearch"),
    ("implement", "address-this"),
    ("review", "review-this"),
])
def test_native_provider_adapter_injects_the_requested_skill_and_exact_cwd(task, skill, tmp_path, monkeypatch):
    launches = []
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _cwd: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, provider="claude": ["codex" if provider == "chatgpt" else "claude"])
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: launches.append((argv, environment, cwd)))
    request = type("Request", (), {"task": task, "provider": "chatgpt", "mode": "interactive", "prompt": "Do it."})()
    sessions.launch_delegated(request, "request", 2, tmp_path)
    argv, environment, cwd = launches[0]
    assert argv[-2:] == ["--", f"${skill}\n\nDo it."]
    assert environment["HARNESS_EXECUTION_MODE"] == "interactive"
    assert cwd == tmp_path.resolve()


def test_native_claude_launch_names_the_session_after_its_agent_number(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _cwd: None)
    request = type("Request", (), {"task": "explore", "provider": "claude", "mode": "auto", "prompt": "Look."})()
    sessions.launch_delegated(request, "request", 3, tmp_path)
    argv = launches[0][0]
    assert argv[argv.index("--name") + 1] == "Agent 3 (explore)"


def test_scoped_aboard_launch_refreshes_endpoint_after_unauthorized_response(tmp_path, monkeypatch):
    endpoints = iter([
        ("127.0.0.1", 4823, "expired"),
        ("127.0.0.1", 4923, "fresh"),
    ])
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda _cwd: next(endpoints))
    calls = []

    def urlopen(request, timeout):
        calls.append((request.full_url, request.headers["Authorization"]))
        if len(calls) == 1:
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
        return io.BytesIO(b'{"ok":true,"sessionId":"aboard-child"}')

    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    request = type("Request", (), {"task": "general", "provider": "claude", "mode": "auto", "prompt": "Do it."})()

    assert sessions.launch_delegated(request, "request", 1, tmp_path) == "aboard-child"
    assert calls == [
        ("http://127.0.0.1:4823/delegations", "Bearer expired"),
        ("http://127.0.0.1:4923/delegations", "Bearer fresh"),
    ]


def test_cli_ask_accepts_only_a_grant_and_reply_accepts_no_message():
    parser = build_parser()
    assert parser.parse_args(["ask", "grant-123"]).grant_id == "grant-123"
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
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: endpoint)
    assert sessions._discover_delegation_endpoint(project) is None

    monkeypatch.setenv("ABOARD_BRIDGE_PORT", "4823")
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    with pytest.raises(sessions.SessionError, match="incomplete"):
        sessions._discover_delegation_endpoint(project)


def test_launch_configuration_resolves_project_then_global_then_defaults(tmp_path, monkeypatch):
    state = tmp_path / "state"
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    monkeypatch.setattr(sessions.shutil, "which", lambda command: command)

    assert sessions.launch_configuration(project) == {"version": 2, "platform": "claude"}
    state.mkdir()
    (state / "launch.json").write_text(
        '{"version":2,"platform":"chatgpt","command":["global-codex"]}', encoding="utf-8"
    )
    assert sessions._provider_command(sessions.launch_configuration(project), "chatgpt") == ["global-codex"]

    (project / ".harness").mkdir()
    (project / ".harness" / "launch.json").write_text(
        '{"version":2,"platform":"claude","command":["project-claude"]}', encoding="utf-8"
    )
    assert sessions._provider_command(sessions.launch_configuration(project), "claude") == ["project-claude"]
    assert sessions._provider_command(sessions.launch_configuration(project), "chatgpt") == ["codex"]
