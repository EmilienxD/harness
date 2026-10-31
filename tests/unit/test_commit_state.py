"""Commit state isolation and real process locking regressions."""
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness/engineering/commit"))
import commit_hook as hook


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    hook.set_provider("chatgpt")
    yield
    hook.set_provider("claude")


def test_state_is_outside_checkout_and_separates_session_provider_and_worktree(tmp_path):
    repo = tmp_path / "repo"
    root = hook._session_dir(str(repo), "session")
    assert root.is_relative_to(tmp_path / "state/runtime/commit/v2")
    with hook._session_lock(root):
        hook._atomic_json(root / "events/receipt.json", {"receipts": []})
    assert not repo.exists()
    assert hook._session_dir(str(repo / ".." / "repo"), "session") == root
    assert hook._session_dir(str(repo), "other-session") != root
    assert hook._session_dir(str(tmp_path / "other-worktree"), "session") != root
    hook.set_provider("claude")
    assert hook._session_dir(str(repo), "session") != root


def test_state_defaults_to_user_harness_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("HARNESS_STATE_DIR")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    root = hook._session_dir(str(tmp_path / "repo"), "session")
    assert root.is_relative_to(tmp_path / "home/.harness/runtime/commit")


def start_lock_process(root, ready, acquired):
    script = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import commit_hook
Path(sys.argv[3]).touch()
with commit_hook._session_lock(Path(sys.argv[2])):
    Path(sys.argv[4]).touch()
    sys.stdin.read()
"""
    return subprocess.Popen(
        [sys.executable, "-c", script, str(Path(hook.__file__).parent), str(root), str(ready), str(acquired)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def wait_for_file(path, process):
    deadline = time.monotonic() + 10
    while not path.exists():
        assert process.poll() is None, process.communicate(timeout=5)
        assert time.monotonic() < deadline, "Lock process did not reach its checkpoint"
        time.sleep(0.01)


def test_contending_process_waits_and_then_acquires_same_lock(tmp_path):
    root = tmp_path / "session"
    ready, acquired = tmp_path / "ready", tmp_path / "acquired"
    process = None
    try:
        with hook._session_lock(root):
            process = start_lock_process(root, ready, acquired)
            wait_for_file(ready, process)
            with pytest.raises(subprocess.TimeoutExpired):
                process.wait(timeout=0.2)
            assert not acquired.exists()
        wait_for_file(acquired, process)
        process.communicate(input=b"", timeout=10)
        assert process.returncode == 0
        assert (root / "ownership.lock").is_file()
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)


def test_lock_timeout_and_process_termination_preserve_recovery(tmp_path):
    root = tmp_path / "session"
    process = start_lock_process(root, tmp_path / "ready", tmp_path / "acquired")
    try:
        wait_for_file(tmp_path / "acquired", process)
        with pytest.raises(TimeoutError, match="ownership is busy"):
            with hook._session_lock(root, timeout=0.1):
                pytest.fail("Acquired another process's lock")
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)
    # A leftover file carries no lock after its owning process dies.
    assert (root / "ownership.lock").exists()
    with hook._session_lock(root, timeout=0.1):
        pass


def test_existing_lock_file_and_exception_do_not_block_later_hooks(tmp_path):
    root = tmp_path / "session"
    root.mkdir()
    (root / "ownership.lock").touch()
    with pytest.raises(ValueError, match="fixture failure"):
        with hook._session_lock(root):
            raise ValueError("fixture failure")
    with hook._session_lock(root, timeout=0.1):
        pass
