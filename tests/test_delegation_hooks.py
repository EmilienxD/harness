from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from harness_cli import hooks, sessions


def configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config: ["claude"])
    return sessions.launch(cwd=tmp_path)


def test_direct_ask_skill_opens_an_unpredictable_task_bound_inbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)

    output = hooks.handle({
        "session_id": parent,
        "hook_event_name": "UserPromptSubmit",
        "prompt": "/ask-agent-to-prototype make a child",
        "cwd": str(tmp_path),
    })

    assert output is not None
    context = output["hookSpecificOutput"]["additionalContext"]
    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        skill, inbox = connection.execute("SELECT skill, inbox FROM grants").fetchone()
    finally:
        connection.close()
    assert skill == "ask-agent-to-prototype"
    assert inbox in context
    assert Path(inbox).parent.name != parent


def test_existing_provider_session_is_registered_by_the_user_invocation_hook(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    output = hooks.handle({
        "session_id": "existing-codex-session", "hook_event_name": "UserPromptSubmit",
        "prompt": "$ask-agent", "cwd": str(tmp_path),
    }, provider="chatgpt")

    assert output is not None
    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT provider, cwd FROM sessions WHERE id = 'existing-codex-session'").fetchone() == ("chatgpt", str(tmp_path.resolve()))
    finally:
        connection.close()


def test_shell_created_request_is_inert_but_exact_structured_write_launches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit",
        "prompt": "/ask-agent", "cwd": str(tmp_path),
    })
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    request = inbox / "child.md"
    request.write_text("---\ntask: general\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
    launched: list[str] = []
    monkeypatch.setattr(sessions, "launch_delegated", lambda parsed, _request, _number, _cwd: launched.append(parsed.prompt) or "child")

    assert hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "Bash", "tool_input": {"command": f"write {request}"},
    }) is None
    assert launched == []

    result = hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "Write", "tool_input": {"file_path": str(request), "content": "..."},
    })
    assert launched == ["Do it."]
    assert result is not None and "1 launched" in result["hookSpecificOutput"]["additionalContext"]


def test_codex_apply_patch_alias_can_launch_multiple_exact_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "$ask-agent", "cwd": str(tmp_path),
    })
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    paths = [inbox / "one.md", inbox / "two.md"]
    for index, path in enumerate(paths, 1):
        path.write_text(f"---\ntask: general\nmode: auto\n---\n\nTask {index}.\n", encoding="utf-8")
    launched: list[str] = []
    monkeypatch.setattr(sessions, "launch_delegated", lambda parsed, _request, _number, _cwd: launched.append(parsed.prompt) or f"child-{len(launched)}")
    patch = "\n".join(f"*** Add File: {path}" for path in paths)

    hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "apply_patch", "tool_input": {"patch": patch},
    })

    assert launched == ["Task 1.", "Task 2."]


def test_structured_request_launch_keeps_the_original_parent_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    parent = configured(project, monkeypatch)
    output = hooks.handle({
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/ask-agent", "cwd": str(project),
    })
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    request = inbox / "child.md"
    request.write_text("---\ntask: general\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
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
        "session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/ask-agent", "cwd": str(tmp_path),
    })
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    request = inbox / "child.md"
    request.write_text("---\ntask: general\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: "child")
    hooks.handle({
        "session_id": parent, "hook_event_name": "PostToolUse",
        "tool_name": "Write", "tool_input": {"file_path": str(request)},
    })
    hooks.handle({
        "session_id": "child", "hook_event_name": "Stop", "cwd": str(tmp_path),
        "last_assistant_message": "Finished safely.",
    }, provider="chatgpt")

    delivered = hooks.handle({
        "session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path),
        "last_assistant_message": "Waiting for children.",
    }, provider="chatgpt")

    assert delivered == {
        "decision": "block",
        "reason": "Agent 1 finished. Agent replied:\n\nFinished safely.\n\n0 agents still running.",
    }


def test_clarification_stop_keeps_an_unused_grant_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({"session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/ask-agent", "cwd": str(tmp_path)})
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])

    assert hooks.handle({"session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path), "last_assistant_message": "done"}) is None
    assert inbox.is_dir()


def test_used_grant_closes_on_parent_stop_and_session_end_cleans_unused_grants(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured(tmp_path, monkeypatch)
    output = hooks.handle({"session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/ask-agent", "cwd": str(tmp_path)})
    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    request = inbox / "child.md"
    request.write_text("---\ntask: general\nmode: auto\n---\n\nDo it.\n", encoding="utf-8")
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: "child")
    hooks.handle({"session_id": parent, "hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": str(request)}})
    hooks.handle({"session_id": "child", "hook_event_name": "SessionEnd", "cwd": str(tmp_path)})

    hooks.handle({"session_id": parent, "hook_event_name": "Stop", "cwd": str(tmp_path), "last_assistant_message": "waiting"})
    assert not inbox.exists()

    second = hooks.handle({"session_id": parent, "hook_event_name": "UserPromptSubmit", "prompt": "/ask-agent", "cwd": str(tmp_path)})
    assert second is not None
    with sqlite3.connect(tmp_path / "state" / "sessions.sqlite3") as connection:
        unused = Path(connection.execute(
            "SELECT inbox FROM grants WHERE parent_session_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1",
            (parent,),
        ).fetchone()[0])
    hooks.handle({"session_id": parent, "hook_event_name": "SessionEnd", "cwd": str(tmp_path)})
    assert not unused.exists()


def test_grant_uses_the_registered_session_cwd_after_parent_changes_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original = tmp_path / "original"
    later = tmp_path / "later"
    original.mkdir()
    later.mkdir()
    parent = configured(original, monkeypatch)

    output = hooks.handle({
        "session_id": parent,
        "hook_event_name": "UserPromptSubmit",
        "prompt": "/ask-agent",
        "cwd": str(later),
    })

    assert output is not None
    inbox = Path(output["hookSpecificOutput"]["additionalContext"].splitlines()[1])
    assert inbox.is_relative_to(original.resolve())
