"""Interactive prerequisites never provision provider resources."""
import json
from pathlib import Path

import pytest

from subagents_runtime import reply_support, sessions


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-home"))
    root = tmp_path / "project"
    root.mkdir()
    return root


def install(root, provider):
    """Stage installer-shaped payloads; the runtime must only read them."""
    base = root / {"claude": ".claude", "chatgpt": ".agents", "pi": ".pi"}[provider]
    if provider == "pi":
        package = base / "npm/node_modules/harness-pi-subagents"
        skill = package / "skills/reply-to-agent/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("installed")
        (package / "extensions").mkdir()
        (package / "extensions/index.ts").write_text("installed")
        (package / "package.json").write_text(json.dumps({"pi": {"skills": ["skills/reply-to-agent"], "extensions": ["extensions/index.ts"]}}))
        (base / "settings.json").write_text(json.dumps({"packages": ["npm:harness-pi-subagents@file:fixture.tgz"]}))
    else:
        for name in ("reply-to-agent", "reply-to-agent-with-previous-message"):
            skill = base / "skills" / name / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("installed")
        source = Path(__file__).resolve().parents[2] / "harness/productivity/subagents" / provider
        fragment = source / ("settings.fragment.json" if provider == "claude" else "hooks.fragment.json")
        target = root / (".claude/settings.json" if provider == "claude" else ".codex/hooks.json")
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(fragment.read_bytes())


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_missing_integration_fails_without_writes(project, provider):
    with pytest.raises(sessions.SessionError):
        reply_support.validate(project, provider)
    assert list(project.iterdir()) == []


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_installed_integration_is_read_only_and_acknowledged(project, monkeypatch, provider):
    install(project, provider)
    before = {p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}
    reply_support.validate(project, provider)
    monkeypatch.setenv("HARNESS_EXECUTION_ID", "execution")
    monkeypatch.setenv("HARNESS_EXECUTION_MODE", "interactive")
    reply_support.acknowledge(project, provider)
    assert reply_support.is_ready("execution", provider)
    assert before == {p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}
    if provider == "pi":
        assert not (project / ".pi/skills").exists()


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_skill_without_integration_is_insufficient(project, provider):
    install(project, provider)
    settings = project / {"claude": ".claude/settings.json", "chatgpt": ".codex/hooks.json", "pi": ".pi/settings.json"}[provider]
    settings.write_text("{}")
    with pytest.raises(sessions.SessionError):
        reply_support.validate(project, provider)


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_user_scope_integration_is_accepted(project, monkeypatch, provider):
    home = project.parent / "home"
    home.mkdir()
    install(home, provider)
    if provider == "pi":
        monkeypatch.setenv("PI_CODING_AGENT_DIR", str(home / ".pi"))
    elif provider == "claude":
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / ".claude"))
    else:
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
        monkeypatch.setenv("CODEX_HOME", str(home / ".codex"))
    reply_support.validate(project, provider)
    assert list(project.iterdir()) == []


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_disabled_hooks_are_rejected(project, provider):
    install(project, provider)
    settings = project / (".claude/settings.json" if provider == "claude" else ".codex/hooks.json")
    value = json.loads(settings.read_text())
    value["disableAllHooks"] = True
    settings.write_text(json.dumps(value))
    with pytest.raises(sessions.SessionError):
        reply_support.validate(project, provider)


def test_disabled_pi_resources_are_rejected(project):
    install(project, "pi")
    settings = project / ".pi/settings.json"
    settings.write_text(json.dumps({"packages": [{"source": "npm:harness-pi-subagents@file:fixture.tgz", "extensions": []}]}))
    with pytest.raises(sessions.SessionError):
        reply_support.validate(project, "pi")


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_missing_integration_never_selects_backend(project, monkeypatch, provider):
    from subagents_runtime import backends
    from types import SimpleNamespace
    monkeypatch.setattr(backends, "select_backend", lambda *args: pytest.fail("backend selected"))
    request = SimpleNamespace(provider=provider, mode="interactive", resume=False, child_skill=None)
    with pytest.raises(sessions.SessionError):
        sessions.launch_delegated(request, "request", 1, project)
    assert list(project.iterdir()) == []
