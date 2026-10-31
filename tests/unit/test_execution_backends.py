"""Public execution-host contracts: isolation, selection, and persisted identity."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from subagents_runtime import backends, bridge_backend, sessions, storage


def test_subagents_has_no_optional_host_references():
    root = Path(sessions.__file__).parents[3]
    for path in root.rglob("*"):
        if path.suffix in {".py", ".json", ".sql", ".toml", ".ts", ".md", ".yaml"}:
            assert "aboard" not in path.name.lower()
            assert "aboard" not in path.read_text(encoding="utf-8").lower(), str(path)


def test_backend_selection_is_extensible_and_never_launches_during_probe(monkeypatch, tmp_path):
    calls = []
    class Backend:
        name = "another-host"
        supports_live_continuation = True
        def probe(self, request, cwd):
            calls.append(cwd)
            return True
        def launch(self, *args):
            pytest.fail("selection must not launch")
    monkeypatch.setattr(backends, "entry_points", lambda **_: [SimpleNamespace(name="custom", load=lambda: Backend)])
    selected = backends.select_backend(SimpleNamespace(mode="auto"), tmp_path)
    assert selected.name == "another-host"
    assert calls == [tmp_path]
    assert backends.supports_live_continuation("another-host")


def test_invalid_inherited_endpoint_does_not_fall_back(monkeypatch, tmp_path):
    monkeypatch.setenv("HARNESS_BRIDGE_PORT", "bad")
    monkeypatch.setenv("HARNESS_BRIDGE_TOKEN", "secret")
    with pytest.raises(sessions.SessionError, match="invalid"):
        backends.select_backend(SimpleNamespace(mode="auto"), tmp_path)


def test_version_ten_migration_preserves_host_handles_and_execution_state(monkeypatch, tmp_path):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    sessions.register_observed("child", tmp_path, "claude")
    with storage.connect() as db:
        db.execute("INSERT INTO executions(id,session_id,backend,state,backend_agent_id,backend_handle) VALUES ('execution','child','previous-host','running','agent','terminal')")
        db.execute("ALTER TABLE executions RENAME COLUMN backend_agent_id TO previous_agent_id")
        db.execute("ALTER TABLE executions RENAME COLUMN backend_handle TO previous_handle")
        db.execute("PRAGMA user_version=10")
    with storage.connect() as db:
        assert db.execute("SELECT id,backend,state,backend_agent_id,backend_handle FROM executions").fetchone() == ("execution", "bridge", "running", "agent", "terminal")
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_endpoint_registry_prefers_latest_live_matching_host(monkeypatch, tmp_path):
    monkeypatch.delenv("HARNESS_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("HARNESS_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(bridge_backend, "endpoint_directory", lambda: tmp_path)
    for name, root, stamp, port in [("old", tmp_path, "1", 1234), ("latest", tmp_path, "2", 2345), ("other", tmp_path / "elsewhere", "3", 3456)]:
        (tmp_path / f"{name}.json").write_text(json.dumps({"version": 2, "host": "127.0.0.1", "port": port, "workspaceRoot": str(root), "pid": os.getpid(), "activatedAt": stamp, "delegationToken": name}))
    assert bridge_backend.discover(tmp_path) == ("127.0.0.1", 2345, "latest")


def test_public_host_lifecycle_preserves_reservation_and_rejects_duplicate_intent(monkeypatch, tmp_path):
    from subagents_runtime import execution_host
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    sessions.register_observed("parent", tmp_path, "claude")
    with storage.connect() as db:
        db.execute("INSERT INTO sessions(id,cwd,parent_session_id,agent_index) VALUES ('child',?,'parent',1)", (str(tmp_path),))
        db.execute("INSERT INTO requests(id,parent_session_id,child_session_id,state) VALUES ('request','parent','child','launching')")
        db.execute("INSERT INTO executions(id,session_id,request_id,backend,state) VALUES ('execution','child','request','standalone','prepared')")
    reserved = execution_host.reservation("request")
    assert (reserved.session_id, reserved.execution_id, reserved.parent_session_id) == ("child", "execution", "parent")
    execution_host.starting(reserved.execution_id, "bridge")
    with pytest.raises(sessions.SessionError, match="already started"):
        execution_host.starting(reserved.execution_id, "bridge")
    execution_host.rejected(reserved.execution_id)
    execution_host.starting(reserved.execution_id, "bridge")
    execution_host.started(reserved.execution_id, os.getpid())
    execution_host.bind(reserved.execution_id, "native", "agent", "terminal")
    execution_host.exited(reserved.execution_id, 1, provider_alive=True, spawn_error=None)
    with storage.connect() as db:
        assert db.execute("SELECT state,backend,backend_agent_id,backend_handle,provider_pid FROM executions").fetchone() == ("uncertain", "bridge", "agent", "terminal", os.getpid())
        assert db.execute("SELECT provider_session_id FROM sessions WHERE id='child'").fetchone() == ("native",)
        assert db.execute("SELECT state FROM requests").fetchone() == ("pending",)
