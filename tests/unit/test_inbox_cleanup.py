from __future__ import annotations

import os
from pathlib import Path
import sqlite3

import pytest

from subagents_runtime import cli, hooks, sessions, storage
from subagents_runtime.delegation import ensure_inbox, process_inbox, reconcile_inbox
from subagents_runtime.inbox_cleanup import cleanup_inboxes, observe_activity


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    monkeypatch.delenv("HARNESS_EXECUTION_ID", raising=False)
    sessions.register_observed("parent", tmp_path, "claude")
    return ensure_inbox("parent").inbox


def ended():
    observe_activity("parent", ended=True)
    with storage.connect() as db:
        db.execute("UPDATE inbox_activity SET last_seen=datetime('now','-8 days')")


def test_preview_apply_and_recreate_preserve_assignment(inbox):
    ended()
    assert cleanup_inboxes()[0].status == "would-remove"
    assert inbox.is_dir()
    assert cleanup_inboxes(apply=True)[0].status == "removed"
    assert not inbox.exists()
    with storage.connect() as db:
        assert db.execute("SELECT inbox FROM session_delegation WHERE parent_session_id='parent'").fetchone() == (str(inbox),)
    assert ensure_inbox("parent").inbox == inbox
    assert inbox.is_dir()
    with storage.connect() as db:
        assert db.execute("SELECT ended_at FROM inbox_activity").fetchone() == (None,)


def test_legacy_and_active_sessions_require_explicit_offline_assertion(inbox):
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    observe_activity("parent")
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "removed"


def test_grace_and_new_activity_prevent_pruning(inbox):
    observe_activity("parent", ended=True)
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    with storage.connect() as db:
        db.execute("UPDATE inbox_activity SET last_seen=datetime('now','-2 days')")
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    assert cli.build_parser().parse_args(["inbox", "cleanup"]).grace_hours == 168
    ended()
    observe_activity("parent")
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    assert inbox.is_dir()


@pytest.mark.parametrize("state", ["prepared", "starting", "running", "uncertain"])
@pytest.mark.parametrize("descendant", [False, True])
def test_active_executions_protected_even_offline(inbox, state, descendant):
    ended()
    with storage.connect() as db:
        owner = "parent"
        if descendant:
            db.execute("INSERT INTO sessions(id,cwd,parent_session_id,agent_index) VALUES ('child',?,'parent',1)", (str(inbox.parent),))
            owner = "child"
        db.execute("INSERT INTO executions(id,session_id,backend,state) VALUES ('e',?,'standalone',?)", (owner, state))
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "skipped"
    assert inbox.is_dir()


@pytest.mark.parametrize("state", ["launching", "pending", "uncertain"])
def test_outstanding_requests_are_protected(inbox, state):
    ended()
    with storage.connect() as db:
        db.execute("INSERT INTO requests(id,parent_session_id,state) VALUES ('r','parent',?)", (state,))
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "skipped"


def test_loop_work_is_protected(inbox):
    ended()
    with storage.connect() as db:
        db.execute("INSERT INTO loop_sessions(session_id,worktree_key,prompt_path) VALUES ('parent','tree','prompt')")
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "skipped"


def test_files_are_never_deleted(inbox):
    ended()
    request = inbox / "request.md"
    request.write_text("payload")
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    assert request.read_text() == "payload"


def test_concurrent_file_creation_prevents_rmdir(inbox, monkeypatch):
    ended()
    original = Path.rmdir

    def racing_rmdir(path):
        (path / "new.md").write_text("concurrent request")
        original(path)

    monkeypatch.setattr(Path, "rmdir", racing_rmdir)
    assert cleanup_inboxes(apply=True)[0].status == "skipped"
    assert (inbox / "new.md").read_text() == "concurrent request"


def test_orphans_require_offline_and_still_must_be_empty(inbox):
    orphan = inbox.parent / "orphan"
    orphan.mkdir()
    assert all(r.status == "skipped" for r in cleanup_inboxes(apply=True))
    results = cleanup_inboxes(apply=True, offline=True)
    assert {r.path for r in results if r.status == "removed"} == {inbox, orphan}


def test_redirected_directory_never_removed(inbox, tmp_path):
    ended()
    target = tmp_path / "target"
    target.mkdir()
    inbox.rmdir()
    try:
        inbox.symlink_to(target, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(inbox), str(target)], check=True, capture_output=True)
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "skipped"
    assert inbox.exists() and target.exists()
    with pytest.raises(sessions.SessionError, match="canonical"):
        ensure_inbox("parent")


def test_redirected_root_never_scanned(inbox, tmp_path):
    root = inbox.parent
    moved = tmp_path / "moved"
    root.rename(moved)
    try:
        root.symlink_to(moved, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(root), str(moved)], check=True, capture_output=True)
    assert cleanup_inboxes(apply=True, offline=True)[0].status == "skipped"
    assert (moved / inbox.name).exists()


@pytest.mark.parametrize("entry", [process_inbox, reconcile_inbox])
def test_processing_restores_missing_inbox(inbox, entry):
    inbox.rmdir()
    assert entry("parent", launch=lambda *_: pytest.fail("unexpected launch")) == []
    assert inbox.is_dir()


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_session_end_prunes_own_inbox_and_resume_without_toolkit_restores_it(inbox, provider):
    hooks.handle({"session_id": "parent", "cwd": str(inbox.parent), "hook_event_name": "SessionEnd"}, provider)
    assert not inbox.exists()
    hooks.handle({"session_id": "parent", "cwd": str(inbox.parent), "hook_event_name": "SessionStart", "source": "resume"}, provider)
    assert inbox.is_dir()
    assert ensure_inbox("parent").inbox == inbox


def test_delegated_resume_restores_parent_directory_before_writing(inbox, monkeypatch):
    from subagents_runtime import delegation
    from types import SimpleNamespace

    with storage.connect() as db:
        db.execute("INSERT INTO sessions(id,provider_session_id,cwd,parent_session_id,agent_index) VALUES ('child','provider-child',?,'parent',1)", (str(inbox.parent),))
    inbox.rmdir()
    paths = []

    def capture(parent, **kwargs):
        assert parent == "parent"
        paths.extend(kwargs["request_paths"])
        assert all(p.is_file() for p in paths)
        return [SimpleNamespace(status="launched")]

    monkeypatch.setattr(delegation, "process_inbox", capture)
    sessions.resume("child", "Continue")
    assert inbox.is_dir()
    assert len(paths) == 1 and paths[0].parent == inbox


def test_version_8_migration_preserves_assignments(inbox):
    with sqlite3.connect(storage.state_dir() / "sessions.sqlite3") as db:
        db.execute("DROP TABLE inbox_activity")
        db.execute("PRAGMA user_version=8")
    with storage.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone() == (storage.SCHEMA_VERSION,)
        assert db.execute("SELECT inbox FROM session_delegation").fetchone() == (str(inbox),)
        assert db.execute("SELECT count(*) FROM inbox_activity").fetchone() == (0,)


def test_cli_default_is_preview_and_apply_is_explicit(inbox, capsys):
    ended()
    assert cli.main(["inbox", "cleanup"]) == 0
    assert inbox.exists()
    assert "would-remove:" in capsys.readouterr().out
    assert cli.main(["inbox", "cleanup", "--apply"]) == 0
    assert not inbox.exists()
    assert "removed:" in capsys.readouterr().out


@pytest.mark.parametrize("hours", ["-1", "nan", "inf"])
def test_invalid_grace_is_rejected(inbox, hours):
    assert cli.main(["inbox", "cleanup", "--grace-hours", hours]) == 1
    assert inbox.exists()
