import os
from pathlib import Path
import re
import subprocess
import sys

import pytest

from subagents_runtime import hooks, inbox_activation, sessions
from subagents_runtime.delegation import scan_inbox


SCRIPT = Path(__file__).resolve().parents[2] / "harness/productivity/subagents/subagents-toolkit/scripts/enable_inbox.py"
IDENTITIES = {"claude": "CLAUDE_CODE_SESSION_ID", "chatgpt": "CODEX_THREAD_ID", "pi": "HARNESS_PI_SESSION_ID"}


def returned_inbox(output):
    match = re.search(r"((?:[A-Za-z]:[\\/]|/)[^\r\n]*[\\/]inboxes[\\/][a-z0-9]{6})", output)
    assert match is not None
    return Path(match.group(1))


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    for variable in (*IDENTITIES.values(), "HARNESS_PROVIDER", "HARNESS_SESSION_ID"):
        monkeypatch.delenv(variable, raising=False)
    return tmp_path


@pytest.mark.parametrize("provider", IDENTITIES)
def test_activation_creates_short_inbox_once_for_the_native_conversation(runtime, monkeypatch, capsys, provider):
    sessions.register_observed("parent", runtime, provider)
    # A native conversation can have a different identity from its Harness launch.
    with sessions._connect() as connection:
        connection.execute("UPDATE sessions SET provider_session_id='native-parent' WHERE id='parent'")
    monkeypatch.setenv("HARNESS_PROVIDER", provider)
    monkeypatch.setenv(IDENTITIES[provider], "native-parent")
    monkeypatch.setenv("HARNESS_SESSION_ID", "inherited-unrelated-session")

    assert inbox_activation.main() == 0
    inbox = returned_inbox(capsys.readouterr().out)
    assert inbox.is_dir() and len(inbox.name) == 6
    assert inbox.parent == runtime / "state" / "inboxes"
    (inbox / "pending.md").write_text("Pending request", encoding="utf-8")
    assert inbox_activation.main() == 0
    assert returned_inbox(capsys.readouterr().out) == inbox
    assert (inbox / "pending.md").is_file()
    assert list(inbox.parent.iterdir()) == [inbox]


@pytest.mark.parametrize("provider", IDENTITIES)
def test_fresh_conversation_does_not_activate_the_inherited_parent(runtime, monkeypatch, capsys, provider):
    sessions.register_observed("parent", runtime, provider)
    sessions.register_observed("fresh", runtime, provider)
    monkeypatch.setenv("HARNESS_PROVIDER", provider)
    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")
    monkeypatch.setenv(IDENTITIES[provider], "fresh")
    assert inbox_activation.main() == 0
    inbox = returned_inbox(capsys.readouterr().out)
    with sessions._connect() as connection:
        assert connection.execute("SELECT parent_session_id,inbox FROM session_delegation").fetchall() == [("fresh", str(inbox))]


def test_unregistered_or_missing_identity_cannot_enable_an_inbox(runtime, monkeypatch, capsys):
    sessions.register_observed("parent", runtime, "chatgpt")
    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")
    assert inbox_activation.main() == 1
    monkeypatch.setenv("CODEX_THREAD_ID", "unknown")
    assert inbox_activation.main() == 1
    assert capsys.readouterr().out == ""
    assert not (runtime / "state" / "inboxes").exists()


def test_no_requests_are_processed_before_activation(runtime, monkeypatch):
    stray = runtime / "state" / "inboxes" / "abcdef"
    stray.mkdir(parents=True)
    (stray / "work.md").write_text("---\nmode: auto\n---\nUnexpected work.", encoding="utf-8")
    hooks.handle({"session_id": "parent", "cwd": str(runtime), "hook_event_name": "SessionStart"}, "claude")
    monkeypatch.setattr(sessions, "launch_delegated", lambda *_args: pytest.fail("Unexpected launch"))
    assert scan_inbox("parent") == []
    assert (stray / "work.md").exists()
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM session_delegation").fetchone() == (0,)


def test_bundled_script_runs_through_the_runtime_entrypoint(runtime, monkeypatch):
    sessions.register_observed("parent", runtime, "chatgpt")
    monkeypatch.setenv("CODEX_THREAD_ID", "parent")
    monkeypatch.setenv("PYTHONPATH", str(SCRIPT.parents[2] / "runtime" / "src"))
    binary = runtime / "bin"
    binary.mkdir()
    if os.name == "nt":
        (binary / "harness-subagents-hook.cmd").write_text(
            f'@echo off\n"{sys.executable}" -m subagents_runtime.hooks %*\n', encoding="utf-8",
        )
    else:
        shim = binary / "harness-subagents-hook"
        import shlex
        shim.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -m subagents_runtime.hooks "$@"\n', encoding="utf-8")
        shim.chmod(0o755)
    monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert returned_inbox(result.stdout).is_dir()
