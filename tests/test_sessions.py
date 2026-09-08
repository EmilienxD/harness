import os
from pathlib import Path

import pytest

from harness_cli import sessions


def test_ask_binds_parent_without_accepting_parent_argument(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda config: ["claude"])
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
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    launches = []
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: launches.append(argv))
    monkeypatch.setattr(sessions, "_command_from_config", lambda config: ["claude"])
    session_id = sessions.launch()
    sessions.resume(session_id)
    assert launches[-1] == ["claude", "--resume", session_id]
