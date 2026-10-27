from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from subagents_runtime import hooks, sessions


@pytest.mark.parametrize(
    "argv, expected",
    [
        (["--claude"], "claude"),
        (["--chatgpt"], "chatgpt"),
        ([], None),
        # Anything that is not the flag is not a provider, including the bare
        # word older settings used to pass.
        (["claude"], None),
        (["chatgpt"], None),
        (["--verbose"], None),
    ],
)
def test_provider_comes_from_the_flag_the_installer_writes(argv, expected) -> None:
    assert hooks.provider_from_argv(argv) == expected


def configured(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    provider: str = "claude",
) -> str:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: ["claude"])
    from subagents_runtime import processes
    monkeypatch.setattr(processes,"start",lambda execution_id,*args,**kwargs: processes.confirm_startup(execution_id))
    return sessions.launch(cwd=tmp_path, provider=provider)


def test_stop_wait_uses_the_provider_neutral_session_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    launch = tmp_path / ".harness" / "config.json"
    launch.parent.mkdir()
    launch.write_text(
        '{"version":1,"autoRun":{"provider":"claude"},"providers":{"claude":{},"chatgpt":{}},"session":{"stopWaitHours":1.5}}',
        encoding="utf-8",
    )
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    assert hooks._stop_wait_seconds(tmp_path) == 5400


@pytest.mark.parametrize("launcher", [
    "subagents-toolkit",
])
def test_direct_ask_skill_opens_an_unpredictable_task_bound_inbox(
    launcher: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent = configured(tmp_path, monkeypatch)

    output = hooks.handle({
        "session_id": parent,
        "hook_event_name": "UserPromptSubmit",
        "prompt": f"/{launcher} make a child",
        "cwd": str(tmp_path),
    })

    assert output is not None
    context = output["hookSpecificOutput"]["additionalContext"]
    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        selected_parent, inbox = connection.execute("SELECT parent_session_id, inbox FROM session_delegation").fetchone()
    finally:
        connection.close()
    assert selected_parent == parent
    assert parent not in inbox
    assert Path(inbox).is_relative_to(tmp_path / "state")


def test_existing_provider_session_is_registered_by_the_user_invocation_hook(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    output = hooks.handle({
        "session_id": "existing-codex-session", "hook_event_name": "UserPromptSubmit",
        "prompt": "$subagents-toolkit", "cwd": str(tmp_path),
    }, provider="chatgpt")

    assert output is not None
    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT provider, cwd FROM sessions WHERE id = 'existing-codex-session'").fetchone() == ("chatgpt", str(tmp_path.resolve()))
    finally:
        connection.close()


@pytest.mark.parametrize(
    "provider, prompt, expected_skill",
    [
        ("claude", "Please use /subagents-toolkit for this change", "subagents-toolkit"),
        ("chatgpt", "Please use $subagents-toolkit for this change", "subagents-toolkit"),
        ("claude", "/ship 7", "ship"),
        ("chatgpt", "$ship 7", "ship"),
        ("chatgpt", "/ship 7", "ship"),
        ("chatgpt", "[$ship](C:/repo/.agents/skills/ship/SKILL.md) 7", "ship"),
    ],
)
def test_ask_skill_invocation_after_prose_opens_its_grant(
    provider: str,
    prompt: str,
    expected_skill: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    output = hooks.handle({
        "session_id": f"existing-{provider}-session",
        "hook_event_name": "UserPromptSubmit",
        "prompt": prompt,
        "cwd": str(tmp_path),
    }, provider=provider)

    assert output is not None
    with sqlite3.connect(tmp_path / "state" / "sessions.sqlite3") as connection:
        assert connection.execute("SELECT parent_session_id FROM session_delegation").fetchone() == (f"existing-{provider}-session",)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("event,tool,response", [
    ("PostToolUse", "Bash", {}),
    ("PostToolUse", "exec_command", {"isError": True}),
    ("PostToolUse", "mcp__custom__tool", {}),
    ("PostToolUseFailure", "Bash", {}),
])
def test_any_tool_completion_scans_only_the_sessions_inbox(tmp_path, monkeypatch, provider, event, tool, response):
    from subagents_runtime.delegation import enable_delegation
    parent = configured(tmp_path, monkeypatch, provider)
    inbox = enable_delegation(parent, "subagents-toolkit").inbox
    other = "other-parent"
    sessions.register_observed(other, tmp_path, provider)
    foreign = enable_delegation(other, "subagents-toolkit").inbox
    body = "---\nmode: interactive\n---\n\nDo it.\n"
    (inbox / "child.md").write_text(body, encoding="utf-8-sig")
    (foreign / "child.md").write_text(body, encoding="utf-8")
    partial = inbox / "child.tmp"
    partial.write_text("---\ntask:", encoding="utf-8")
    launched = []
    monkeypatch.setattr(sessions, "launch_delegated", lambda parsed, *_args: launched.append(parsed) or "child")

    payload = {"session_id": parent, "hook_event_name": event, "tool_name": tool,
               "tool_response": response, "cwd": str(tmp_path)}
    output = hooks.handle(payload, provider=provider)
    hooks.handle(payload, provider=provider)

    assert len(launched) == 1
    assert launched[0].mode == "interactive"
    assert output is not None
    assert (foreign / "child.md").exists()
    assert partial.read_text() == "---\ntask:"
    with sessions._connect() as db:
        assert db.execute("SELECT state FROM requests WHERE parent_session_id=?", (parent,)).fetchall() == [("pending",)]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_stop_discovers_a_shell_request_before_waiting(tmp_path, monkeypatch, provider):
    from subagents_runtime.delegation import enable_delegation, has_pending_children
    parent = configured(tmp_path, monkeypatch, provider)
    inbox = enable_delegation(parent, "subagents-toolkit").inbox
    (inbox / "child.md").write_text("---\nmode: interactive\n---\nDo it.", encoding="utf-8-sig")
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: "child")
    waited = []
    def wait(session_id, **_kwargs):
        waited.append(has_pending_children(session_id))
    monkeypatch.setattr(hooks, "wait_parent_delivery", wait)

    hooks.handle({"session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path),
                  "last_assistant_message": "Waiting."}, provider=provider)

    assert waited == [True]
    assert not list(inbox.glob("*.md*"))


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_resume_discovers_queued_requests_without_a_tool_event(tmp_path, monkeypatch, provider):
    from subagents_runtime.delegation import enable_delegation
    parent = configured(tmp_path, monkeypatch, provider)
    inbox = enable_delegation(parent, "subagents-toolkit").inbox
    (inbox / "child.md").write_text("---\nmode: auto\n---\nDo it.", encoding="utf-8")
    launched = []
    monkeypatch.setattr(sessions, "launch_delegated", lambda parsed, *_args: launched.append(parsed) or "child")

    hooks.handle({"session_id": parent, "hook_event_name": "SessionStart", "source": "resume", "cwd": str(tmp_path)}, provider=provider)

    assert len(launched) == 1


def test_codex_apply_patch_alias_can_launch_multiple_exact_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch, provider="chatgpt")
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "$subagents-toolkit", "cwd": str(tmp_path),
    }, provider="chatgpt")
    assert output is not None
    inbox = __import__("subagents_runtime.delegation",fromlist=["enable_delegation"]).enable_delegation(parent,"subagents-toolkit").inbox
    paths = [inbox / "one.md", inbox / "two.md"]
    for index, path in enumerate(paths, 1):
        path.write_text(f"---\nmode: auto\n---\n\nTask {index}.\n", encoding="utf-8")
    launched: list[str] = []
    monkeypatch.setattr(sessions, "launch_delegated", lambda parsed, _request, _number, _cwd: launched.append(parsed.prompt) or f"child-{len(launched)}")
    patch = "\n".join(f"*** Add File: {path}" for path in paths)

    hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "apply_patch", "tool_input": {"patch": patch},
    }, provider="chatgpt")

    assert launched == ["Task 1.", "Task 2."]


def test_structured_request_launch_keeps_the_original_parent_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    parent = configured(project, monkeypatch)
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/subagents-toolkit", "cwd": str(project),
    })
    assert output is not None
    inbox = __import__("subagents_runtime.delegation",fromlist=["enable_delegation"]).enable_delegation(parent,"subagents-toolkit").inbox
    request = inbox / "child.md"
    request.write_text("---\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
    launched_from: list[Path] = []
    monkeypatch.setattr(
        sessions,
        "launch_delegated",
        lambda _parsed, _request, _number, cwd: launched_from.append(cwd) or "child",
    )

    hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "Write", "tool_input": {"file_path": str(request)},
    })

    assert launched_from == [project.resolve()]


def test_chatgpt_stop_delivery_wakes_the_waiting_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/subagents-toolkit", "cwd": str(tmp_path),
    })
    assert output is not None
    inbox = __import__("subagents_runtime.delegation",fromlist=["enable_delegation"]).enable_delegation(parent,"subagents-toolkit").inbox
    request = inbox / "child.md"
    request.write_text("---\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: "child")
    hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "Write", "tool_input": {"file_path": str(request)},
    })
    hooks.handle({
        "session_id": "child", "hook_event_name": "Stop", "cwd": str(tmp_path),
        "last_assistant_message": "Finished safely.",
    }, provider="claude")

    delivered = hooks.handle({
        "session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path),
        "last_assistant_message": "Waiting for children.",
    }, provider="chatgpt")

    assert delivered is not None and delivered["decision"] == "block"
    assert "Finished safely." in delivered["reason"]


def test_clarification_stop_keeps_an_unused_grant_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({"session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/subagents-toolkit", "cwd": str(tmp_path)})
    assert output is not None
    inbox = __import__("subagents_runtime.delegation",fromlist=["enable_delegation"]).enable_delegation(parent,"subagents-toolkit").inbox

    assert hooks.handle({"session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path), "last_assistant_message": "done"}) is None
    assert inbox.is_dir()


def test_parent_shutdown_preserves_delegation_inbox(tmp_path,monkeypatch):
    parent = configured(tmp_path,monkeypatch)
    hooks.handle({"session_id":parent,"cwd":str(tmp_path),"hook_event_name":"UserPromptSubmit","prompt":"/subagents-toolkit"})
    from subagents_runtime.delegation import enable_delegation
    inbox = enable_delegation(parent,"subagents-toolkit").inbox
    hooks.handle({"session_id":parent,"cwd":str(tmp_path),"hook_event_name":"PreToolUse"})
    hooks.handle({"session_id":parent,"cwd":str(tmp_path),"hook_event_name":"SessionEnd"})
    assert inbox.is_dir()
    assert hooks.handle({"session_id":parent,"cwd":str(tmp_path),"hook_event_name":"SessionStart","source":"resume"}) is None


def test_grant_uses_the_registered_session_cwd_after_parent_changes_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original = tmp_path / "original"
    later = tmp_path / "later"
    original.mkdir()
    later.mkdir()
    parent = configured(original, monkeypatch)

    output = hooks.handle({
        "session_id": parent,
        "hook_event_name": "UserPromptSubmit",
        "prompt": "/subagents-toolkit",
        "cwd": str(later),
    })

    assert output is not None
    inbox = __import__("subagents_runtime.delegation",fromlist=["enable_delegation"]).enable_delegation(parent,"subagents-toolkit").inbox
    assert inbox.is_relative_to(original / "state")
