from pathlib import Path

import pytest

from subagents_runtime import processes, roles, sessions, bridge_backend
from subagents_runtime.delegation import RequestFileError, enable_delegation, parse_request_file, process_inbox


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    (root / ".git").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    monkeypatch.setattr(bridge_backend, "discover", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(sessions, "launch_configuration", lambda _: {})
    return root


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
@pytest.mark.parametrize("selected", [None, "security-audit"])
def test_explicit_skill_launch_and_resume(project, monkeypatch, provider, mode, selected):
    directory = {"claude": ".claude", "chatgpt": ".agents", "pi": ".pi"}[provider]
    if selected:
        path = project / directory / "skills" / selected / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text("---\nname: security-audit\ndescription: Audit security.\n---\n")
    sessions.register_observed("parent", project, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    header = f"skill: {selected}\n" if selected else ""
    (inbox / "work.md").write_text(f"---\nmode: {mode}\n{header}---\nInspect the API.")
    launches = []
    def start(execution, argv, environment, cwd, visible):
        launches.append((argv, environment, cwd, visible))
        from subagents_runtime.reply_support import _write
        from subagents_runtime.storage import state_dir

        _write(state_dir() / "runtime/reply-ready" / execution, provider.encode())
        with sessions._connect() as connection:
            connection.execute("UPDATE sessions SET provider_session_id=id WHERE id=?", (environment["HARNESS_SESSION_ID"],))
        processes.confirm_startup(execution)
    monkeypatch.setattr(processes, "start", start)
    [first] = process_inbox("parent", launch=sessions.launch_delegated)
    assert first.status == "launched", first.reason
    argv, environment, cwd, visible = launches[0]
    assert cwd == project
    assert visible == (mode == "interactive")
    assert environment["HARNESS_PROVIDER"] == provider
    # Assert invocation syntax, not instruction wording.
    if selected:
        prefix = {"claude": "/", "chatgpt": "$", "pi": "/skill:"}[provider]
        assert argv[-1].split()[0] == prefix + selected
        path.unlink()
    with sessions._connect() as connection:
        connection.execute("UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,))
        connection.execute("UPDATE executions SET state='exited' WHERE request_id=?", (first.request_id,))
    (inbox / "resume.md").write_text("---\nresume: agent-1\n---\nContinue.")
    resumed = []
    [result] = process_inbox("parent", launch=lambda request, *_: resumed.append(request) or "conversation")
    assert result.status == "launched", result.reason
    assert result.child_session_id == first.child_session_id
    assert resumed[0].child_skill is None
    assert (resumed[0].provider, resumed[0].mode) == (provider, mode)


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_missing_skill_fails_before_any_launch(project, monkeypatch, provider):
    sessions.register_observed("parent", project, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text("---\nmode: auto\nskill: missing-audit\n---\nInspect.")
    monkeypatch.setattr(processes, "start", lambda *_a, **_kw: pytest.fail("Missing skill launched"))
    monkeypatch.setattr(bridge_backend, "discover", lambda *_a, **_kw: pytest.fail("Missing skill reached backend selection"))
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    assert result.status == "failed"
    assert "missing-audit" in result.reason
    with sessions._connect() as connection:
        assert connection.execute("SELECT state FROM requests").fetchone() == ("failed",)
    assert not list(inbox.iterdir())


def test_no_registry_loading_and_no_skill_inference(project):
    registry = project / ".harness" / "subagent-tasks.yaml"
    registry.parent.mkdir()
    registry.write_text("[invalid obsolete yaml")
    sessions.register_observed("parent", project, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    path = inbox / "work.md"
    path.write_text("---\nmode: auto\n---\nPrototype a websearch tool.")
    assert parse_request_file(path, inbox, parent_provider="claude").child_skill is None
    path.write_text("---\ntask: prototype\nmode: auto\n---\nWork.")
    with pytest.raises(RequestFileError, match="unsupported frontmatter"):
        parse_request_file(path, inbox, parent_provider="claude")


def test_previous_schema_migrates_without_losing_requests(project):
    sessions.register_observed("parent", project, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text("---\nmode: auto\n---\nInspect.")
    [first] = process_inbox("parent", launch=lambda *_: "provider-session")
    with sessions._connect() as connection:
        connection.execute("ALTER TABLE requests DROP COLUMN skill")
        connection.execute("PRAGMA user_version=9")
    with sessions._connect() as connection:
        assert connection.execute("SELECT skill FROM requests WHERE id=?", (first.request_id,)).fetchone() == (None,)
        assert connection.execute("SELECT provider_session_id FROM sessions WHERE id=?", (first.child_session_id,)).fetchone() == ("provider-session",)


def test_recovery_refuses_a_changed_skill(project, monkeypatch):
    sessions.register_observed("parent", project, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text("---\nmode: auto\nskill: first-audit\n---\nInspect.")
    with pytest.raises(KeyboardInterrupt):
        process_inbox("parent", launch=lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    [claimed] = inbox.iterdir()
    claimed.write_text("---\nmode: auto\nskill: second-audit\n---\nInspect.")
    monkeypatch.setattr(processes, "birth_identity", lambda _: "new-process")
    [result] = process_inbox("parent", launch=lambda *_: pytest.fail("Changed skill relaunched"))
    assert result.status == "failed"
    with sessions._connect() as connection:
        assert connection.execute("SELECT skill,state FROM requests").fetchone() == ("first-audit", "failed")
