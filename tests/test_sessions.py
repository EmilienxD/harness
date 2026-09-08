import os
import sqlite3
from pathlib import Path

import pytest

from harness_cli import sessions


def configured(tmp_path, monkeypatch, launches):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(
        sessions,
        "_visible_terminal",
        lambda argv, environment, cwd: launches.append((argv, environment, cwd)),
    )
    monkeypatch.setattr(sessions, "_command_from_config", lambda config: ["claude"])


def test_ask_binds_parent_without_accepting_parent_argument(tmp_path, monkeypatch):
    configured(tmp_path, monkeypatch, [])
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    request, child = sessions.ask("inspect this")
    monkeypatch.setenv("HARNESS_SESSION_ID", child)
    monkeypatch.setenv("HARNESS_REQUEST_ID", request)
    delivery = sessions.reply("done")
    assert delivery
    with pytest.raises(sessions.SessionError, match="already been answered"):
        sessions.reply("again")


def test_resume_uses_registered_session(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    session_id = sessions.launch()
    sessions.resume(session_id)
    assert launches[-1][0] == ["claude", "--resume", session_id]
    assert launches[-1][1]["HARNESS_SESSION_ID"] == session_id


def test_parent_can_have_multiple_requests_and_each_child_can_only_answer_its_own(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    first_request, first_child = sessions.ask("first")
    second_request, second_child = sessions.ask("second")

    monkeypatch.setenv("HARNESS_SESSION_ID", second_child)
    monkeypatch.setenv("HARNESS_REQUEST_ID", first_request)
    with pytest.raises(sessions.SessionError, match="unknown or has already been answered"):
        sessions.reply("spoofed")

    monkeypatch.setenv("HARNESS_SESSION_ID", first_child)
    sessions.reply("one")
    monkeypatch.setenv("HARNESS_SESSION_ID", second_child)
    monkeypatch.setenv("HARNESS_REQUEST_ID", second_request)
    sessions.reply("two")
    assert [launch[0][-1] for launch in launches[1:]] == ["first", "second"]


def test_failed_terminal_launch_rolls_back_session_and_request_state(tmp_path, monkeypatch):
    configured(tmp_path, monkeypatch, [])
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: (_ for _ in ()).throw(OSError("no terminal")))
    with pytest.raises(OSError, match="no terminal"):
        sessions.ask("will fail")

    connection = sqlite3.connect(tmp_path / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM requests").fetchone()[0] == 0
    finally:
        connection.close()


def test_resume_restores_child_request_identity_and_original_working_directory(tmp_path, monkeypatch):
    launches = []
    configured(tmp_path, monkeypatch, launches)
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    request, child = sessions.ask("inspect")
    sessions.resume(child)
    argv, environment, cwd = launches[-1]
    assert argv == ["claude", "--resume", child]
    assert environment["HARNESS_SESSION_ID"] == child
    assert environment["HARNESS_REQUEST_ID"] == request
    assert cwd == Path.cwd().resolve()


def test_shell_command_builders_preserve_spaces_quotes_and_harness_identity():
    argv = ["C:\\Program Files\\Claude\\claude.exe", "say 'hello'", 'and "goodbye"']
    powershell = sessions._powershell_command(argv)
    assert powershell == "& 'C:\\Program Files\\Claude\\claude.exe' 'say ''hello''' 'and \"goodbye\"'"

    mac = sessions._macos_terminal_command(
        ["claude", "a prompt with spaces"],
        {"PATH": "/bin", "HARNESS_SESSION_ID": "session 1", "HARNESS_REQUEST_ID": "request-1"},
        Path("/tmp/a project"),
    )
    assert "HARNESS_SESSION_ID=session 1" in mac
    assert "HARNESS_REQUEST_ID=request-1" in mac
    assert "a prompt with spaces" in mac
    assert "PATH=" not in mac


def test_array_commands_are_argv_and_preserve_token_contents():
    assert sessions._command(["wrapper", " profile with spaces "], "terminalCommand") == [
        "wrapper",
        " profile with spaces ",
    ]


def test_invalid_command_is_rejected_before_ask_creates_durable_state(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config: ["claude"])
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config: (_ for _ in ()).throw(sessions.SessionError("bad command")))
    with pytest.raises(sessions.SessionError, match="bad command"):
        sessions.ask("inspect")
    connection = sqlite3.connect(tmp_path / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM requests").fetchone()[0] == 0
    finally:
        connection.close()
