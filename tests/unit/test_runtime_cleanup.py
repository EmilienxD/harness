import os
import time

import pytest

from subagents_runtime.storage import connect


def test_storage_cleans_old_execution_files_but_keeps_conversation(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    with connect() as connection:
        connection.execute("INSERT INTO sessions(id,cwd) VALUES ('parent',?)", (str(tmp_path),))
        connection.execute("INSERT INTO executions(id,session_id,backend,state,created_at,exited_at) VALUES ('old','parent','standalone','exited','2000-01-01','2000-01-01')")
        connection.execute("INSERT INTO executions(id,session_id,backend,state,created_at,exited_at) VALUES ('other','parent','standalone','exited','2000-01-01','2000-01-01')")
    root = tmp_path / "runtime" / "sessions" / "parent"
    inbox = root / "inbox"
    inbox.mkdir(parents=True)
    execution = root / "executions" / "old"
    execution.mkdir(parents=True)
    (execution / "stderr.log").write_text("old diagnostics")
    other = root / "executions" / "other"
    other.mkdir()
    (other / "stderr.log").write_text("more diagnostics")
    old = time.time() - 8 * 86400
    for path in sorted(root.rglob("*"), reverse=True):
        os.utime(path, (old, old))
    os.utime(root, (old, old))
    with connect() as connection:
        connection.execute("UPDATE sessions SET created_at='2000-01-01'")
    with connect():
        pass
    assert not execution.exists()
    assert not other.exists()
    assert inbox.is_dir()


@pytest.mark.parametrize("protection", ["recent-file", "queued-request", "running", "uncertain", "undelivered"])
def test_storage_preserves_recoverable_or_recent_execution_files(tmp_path, monkeypatch, protection):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    with connect() as connection:
        connection.execute("INSERT INTO sessions(id,cwd,created_at) VALUES ('parent',?,'2000-01-01')", (str(tmp_path),))
        connection.execute("INSERT INTO executions(id,session_id,backend,state,created_at,exited_at) VALUES ('old','parent','standalone','exited','2000-01-01','2000-01-01')")
        if protection in {"running", "uncertain"}:
            connection.execute("INSERT INTO executions(id,session_id,backend,state,created_at) VALUES ('active','parent','standalone',?,'2000-01-01')", (protection,))
        if protection == "undelivered":
            connection.execute("INSERT INTO requests(id,parent_session_id,state,created_at,completed_at) VALUES ('reply','parent','succeeded','2000-01-01','2000-01-01')")
    root = tmp_path / "runtime" / "sessions" / "parent"
    execution = root / "executions" / "old"
    execution.mkdir(parents=True)
    log = execution / "stderr.log"
    log.write_text("diagnostics")
    inbox = root / "inbox"
    inbox.mkdir()
    if protection == "queued-request":
        (inbox / "task.md").write_text("pending")
    old = time.time() - 8 * 86400
    for path in [root, *root.rglob("*")]:
        os.utime(path, (old, old))
    if protection == "recent-file":
        os.utime(log, None)
    with connect():
        pass
    assert log.read_text() == "diagnostics"


def test_storage_opens_without_waiting_for_cleanup_when_busy(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    (tmp_path / "runtime" / "sessions").mkdir(parents=True)
    with connect() as writer:
        writer.execute("BEGIN IMMEDIATE")
        with connect() as reader:
            assert reader.execute("SELECT COUNT(*) FROM sessions").fetchone() == (0,)
