from pathlib import Path

import pytest

from subagents_runtime import hooks, sessions
from subagents_runtime.delegation import enable_delegation, process_inbox


@pytest.fixture
def project(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    for name in ("CLAUDE_CONFIG_DIR", "HARNESS_SESSION_ID", "HARNESS_EXECUTION_ID"):
        monkeypatch.delenv(name, raising=False)
    return project


def install_toolkit(root, provider):
    directory = ".claude" if provider == "claude" else ".agents"
    skill = root / directory / "skills" / "subagents-toolkit" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: subagents-toolkit\n---\n", encoding="utf-8")
    return skill


def start(project, provider, source="startup", session="parent"):
    return hooks.handle({
        "session_id": session, "cwd": str(project),
        "hook_event_name": "SessionStart", "source": source,
    }, provider)


def assigned_inbox(session="parent"):
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT inbox FROM session_delegation WHERE parent_session_id=?", (session,)
        ).fetchone()
    return Path(row[0]) if row else None


@pytest.mark.parametrize(("provider", "scope"), [
    ("claude", "project"), ("chatgpt", "project"),
    ("claude", "personal"), ("chatgpt", "personal"), ("claude", "claude-config"),
])
def test_installed_toolkit_does_not_assign_inbox_or_load_registries(
    project, monkeypatch, provider, scope,
):
    if scope == "claude-config":
        root = project.parent / "configured"
        install_toolkit(root, provider)
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(root / ".claude"))
    else:
        install_toolkit(project if scope == "project" else Path.home(), provider)
    registry = project / ".harness" / "subagent-tasks.yaml"
    registry.parent.mkdir()
    registry.write_text("[invalid yaml", encoding="utf-8")
    read_text = Path.read_text

    def read_runtime_data(path, *args, **kwargs):
        if path.suffix in {".md", ".yaml"}:
            pytest.fail("startup read skill instructions or a registry")
        return read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_runtime_data)

    output = start(project, provider)

    assert output is None
    assert assigned_inbox() is None
    assert not (project.parent / "state" / "inboxes").exists()
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM requests").fetchone() == (0,)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("other_provider_installed", [False, True])
def test_missing_toolkit_does_not_assign_inbox_or_inject_context(
    project, provider, other_provider_installed,
):
    if other_provider_installed:
        install_toolkit(project, "chatgpt" if provider == "claude" else "claude")
    assert start(project, provider) is None
    assert assigned_inbox() is None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_resume_and_compaction_keep_enabled_inbox_without_disclosure(project, provider):
    install_toolkit(project, provider)
    assert start(project, provider) is None
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    for source in ("resume", "compact"):
        hooks.handle({"session_id": "parent", "cwd": str(project),
                      "hook_event_name": "PreToolUse"}, provider)
        inbox.rmdir()
        assert start(project, provider, source) is None
        assert assigned_inbox() == inbox
        assert inbox.is_dir()
    assert list(inbox.parent.iterdir()) == [inbox]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("source", ["clear", "fork"])
def test_fresh_conversation_needs_separate_activation(project, monkeypatch, provider, source):
    install_toolkit(project, provider)
    assert start(project, provider) is None
    original = enable_delegation("parent", "subagents-toolkit").inbox
    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")
    assert start(project, provider, source, "fresh") is None
    assert assigned_inbox("fresh") is None
    assert enable_delegation("fresh", "subagents-toolkit").inbox != original
    assert assigned_inbox() == original


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_natural_language_delegation_launches_without_launcher_invocation(
    project, monkeypatch, provider,
):
    install_toolkit(project, provider)
    assert start(project, provider) is None
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    hooks.handle({"session_id": "parent", "cwd": str(project),
                  "hook_event_name": "UserPromptSubmit",
                  "prompt": "Run a Claude subagent to inspect the API."}, provider)
    request = inbox / "inspect.md"
    request.write_text(
        "---\nmode: auto\nprovider: claude\n---\nInspect the API.",
        encoding="utf-8",
    )
    launched = []
    monkeypatch.setattr(
        sessions, "launch_delegated",
        lambda parsed, *_args: launched.append(parsed.provider) or "child",
    )
    output = hooks.handle({
        "session_id": "parent", "cwd": str(project), "hook_event_name": "PostToolUse",
        "tool_name": "Write" if provider == "claude" else "apply_patch",
        "tool_input": ({"file_path": str(request)} if provider == "claude" else
                       {"command": f"*** Add File: {request}"}),
    }, provider)
    assert output is not None
    assert launched == ["claude"]
    assert enable_delegation("parent", "subagents-toolkit").inbox == inbox
    with sessions._connect() as connection:
        assert connection.execute("SELECT state FROM requests").fetchone() == ("pending",)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_removed_toolkit_suppresses_session_start_instructions(project, provider):
    skill = install_toolkit(project, provider)
    assert start(project, provider) is None
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    skill.unlink()
    assert start(project, provider, "resume") is None
    assert assigned_inbox() == inbox


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("delegated", [False, True])
def test_ordinary_turns_receive_no_delegation_instructions(project, monkeypatch, provider, delegated):
    install_toolkit(project, provider)
    assert start(project, provider) is None
    session_id = "parent"
    if delegated:
        enable_delegation("parent", "subagents-toolkit")
        (assigned_inbox() / "child.md").write_text(
            "---\nmode: auto\n---\nExplain the configuration.", encoding="utf-8",
        )
        [child] = process_inbox("parent", launch=lambda *_args: "child-conversation")
        session_id = child.child_session_id
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: pytest.fail("unexpected child launch"))

    for source in ("startup", "resume", "compact"):
        assert start(project, provider, source, session_id) is None
        for event in ("UserPromptSubmit", "PreToolUse", "PostToolUse"):
            assert hooks.handle({
                "session_id": session_id, "cwd": str(project), "hook_event_name": event,
                "prompt": "Explain the configuration.", "tool_name": "Read", "tool_input": {},
            }, provider) is None
    with sessions._connect() as connection:
        assert connection.execute(
            "SELECT count(*) FROM requests WHERE parent_session_id=?", (session_id,),
        ).fetchone() == (0,)
