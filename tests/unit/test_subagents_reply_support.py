"""Reply integration preparation and readiness, independent of model inference."""
import json

import pytest

from subagents_runtime import reply_support, sessions


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    root = tmp_path / "project"
    root.mkdir()
    return root


@pytest.mark.parametrize("provider,directory", [("claude", ".claude"), ("chatgpt", ".agents"), ("pi", ".pi")])
def test_preparation_is_repeatable_and_supplies_reply_resources(project, provider, directory):
    reply_support.prepare(project, provider)
    skill = project / directory / "skills/reply-to-agent/SKILL.md"
    assert skill.is_file()
    before = {p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}
    reply_support.prepare(project, provider)
    assert before == {p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}


@pytest.mark.parametrize("provider,path", [("claude", ".claude/settings.json"), ("chatgpt", ".codex/hooks.json")])
def test_preserves_unrelated_settings_and_hooks(project, provider, path):
    target = project / path
    target.parent.mkdir()
    existing = {"permissions": {"deny": ["Write"]}, "hooks": {"Stop": [{"hooks": [{"command": "unrelated"}]}]}}
    target.write_text(json.dumps(existing))
    reply_support.prepare(project, provider)
    actual = json.loads(target.read_text())
    assert actual["permissions"] == existing["permissions"]
    assert actual["hooks"]["Stop"][0] == existing["hooks"]["Stop"][0]


def test_inherited_hook_registration_is_not_duplicated(project, monkeypatch):
    home = project.parent / "claude-home"
    home.mkdir()
    inherited = {"hooks": {"Stop": [{"hooks": [{"command": "harness-subagents-hook"}]}]}}
    (home / "settings.json").write_text(json.dumps(inherited))
    reply_support.prepare(project, "claude")
    actual = json.loads((project / ".claude/settings.json").read_text())
    assert actual["hooks"]["Stop"] == []


def test_conflicting_skill_is_not_overwritten(project):
    path = project / ".claude/skills/reply-to-agent/SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"user-owned")
    with pytest.raises(sessions.SessionError, match="Conflicting reply support"):
        reply_support.prepare(project, "claude")
    assert path.read_bytes() == b"user-owned"
    assert not (project / ".claude/settings.json").exists()


def test_readiness_requires_loaded_integration_and_skills(project, monkeypatch):
    monkeypatch.setenv("HARNESS_EXECUTION_ID", "execution")
    monkeypatch.setenv("HARNESS_EXECUTION_MODE", "interactive")
    marker = reply_support.state_dir() / "runtime/reply-ready/execution"
    reply_support.acknowledge(project, "claude")
    assert not marker.exists()
    reply_support.prepare(project, "claude")
    assert not marker.exists()
    reply_support.acknowledge(project, "claude")
    reply_support.wait_ready("execution", "claude")
    assert marker.read_text() == "claude"


def test_unavailable_support_settles_request_without_forgetting_process(project, monkeypatch):
    from subagents_runtime import processes
    from subagents_runtime.delegation import enable_delegation, process_inbox

    sessions.register_observed("parent", project, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "child.md").write_text("---\nmode: interactive\n---\nWork.")
    monkeypatch.setattr(processes, "start", lambda execution, *args, **kwargs: processes.confirm_startup(execution))
    def unavailable(*args):
        raise reply_support.ReplySupportUnavailable("Reply support unavailable: disabled hooks")
    monkeypatch.setattr(reply_support, "wait_ready", unavailable)
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    assert result.status == "failed"
    with sessions._connect() as db:
        request = db.execute("SELECT state,reason,delivery_id FROM requests WHERE id=?", (result.request_id,)).fetchone()
        execution = db.execute("SELECT state FROM executions WHERE request_id=?", (result.request_id,)).fetchone()
    assert request[0] == "cancelled"
    assert request[1] == "Reply support unavailable: disabled hooks"
    assert request[2]
    assert execution[0] == "running"
    assert processes.live_executions(result.child_session_id)


def test_missing_readiness_is_bounded_and_explicit(project, monkeypatch):
    times = iter([0, 31])
    monkeypatch.setattr(reply_support.time, "monotonic", lambda: next(times))
    with pytest.raises(reply_support.ReplySupportUnavailable, match="did not acknowledge"):
        reply_support.wait_ready("execution", "claude")
