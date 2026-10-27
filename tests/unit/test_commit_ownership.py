"""Real Git regressions for the shared Claude/ChatGPT ownership contract."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness/engineering/commit"))
import commit_hook as hook


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


@pytest.fixture(params=["claude", "chatgpt"])
def session(tmp_path, request):
    hook.set_provider(request.param)
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.invalid")
    for name in ["owned.txt", "other.txt"]:
        (tmp_path / name).write_text("before\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "seed")
    root = hook._session_dir(str(tmp_path), "session")
    payload = {"session_id": "session", "cwd": str(tmp_path), "tool_use_id": "write",
               "tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "owned.txt"), "content": "after\n"}}
    yield tmp_path, root, payload
    hook.set_provider("claude")


def write(session):
    repo, root, payload = session
    hook._record_pre(payload, str(repo), root)
    (repo / "owned.txt").write_bytes(b"after\n")
    hook._record_post(payload, str(repo), root)


def commit(session, capsys, ai=False, dry=False):
    repo, root, payload = session
    with pytest.raises(SystemExit):
        hook._handle_commit(payload, str(repo), root, hook.Flags(dry, ai), "change")
    captured = capsys.readouterr()
    return json.loads(captured.out)["reason"] if hook.PROVIDER == "chatgpt" else captured.err


@pytest.mark.parametrize("problem", ["no-evidence", "foreign-before", "foreign-after", "head", "partial-index", "pending", "corrupt", "failed", "overlap"])
def test_uncertain_ownership_never_mutates_git(session, capsys, problem):
    repo, root, payload = session
    if problem == "foreign-before":
        (repo / "owned.txt").write_text("user edit\n")
    if problem != "no-evidence":
        if problem in {"failed", "pending", "overlap"}:
            hook._record_pre(payload, str(repo), root)
            if problem == "overlap":
                hook._record_pre({**payload, "tool_use_id": "second"}, str(repo), root)
            (repo / "owned.txt").write_bytes(b"after\n")
            if problem != "pending":
                hook._record_post({**payload, "hook_event_name": "PostToolUseFailure"} if problem == "failed" else payload, str(repo), root)
                if problem == "overlap":
                    hook._record_post({**payload, "tool_use_id": "second"}, str(repo), root)
        else:
            write(session)
    if problem == "foreign-after":
        (repo / "owned.txt").write_text("later user edit\n")
    if problem == "head":
        git(repo, "commit", "--allow-empty", "-qm", "external")
    if problem == "partial-index":
        git(repo, "add", "owned.txt")
    if problem == "corrupt":
        next((root / "events").glob("*.json")).write_text("broken")
    before = (git(repo, "rev-parse", "HEAD"), git(repo, "diff", "--cached"))
    if problem == "corrupt":
        with pytest.raises(ValueError):
            hook._ownership_records(root)
    else:
        result = commit(session, capsys)
        expected = {"no-evidence": "No verified writes", "foreign-before": "preexisting or foreign",
                    "foreign-after": "changed after its observed write", "head": "HEAD changed",
                    "partial-index": "already has staged changes", "pending": "unfinished or unobserved",
                    "failed": "failed tool changed", "overlap": "Concurrent tool snapshots overlap"}
        assert expected[problem] in result
    assert (git(repo, "rev-parse", "HEAD"), git(repo, "diff", "--cached")) == before


def test_verified_commit_preserves_unrelated_staging_and_resets_ownership(session, capsys):
    repo, root, _ = session
    (repo / "other.txt").write_text("user change\n")
    git(repo, "add", "other.txt")
    staged = git(repo, "diff", "--cached")
    write(session)
    assert "Committed " in commit(session, capsys)
    assert git(repo, "show", "--pretty=", "--name-only").strip() == "owned.txt"
    assert git(repo, "diff", "--cached") == staged
    assert hook._ownership().owned(hook._ownership_records(root))[0] == {}
    assert "Committed " not in commit(session, capsys)


def test_dry_run_preserves_index_and_head(session, capsys):
    repo, _, _ = session
    write(session)
    before = git(repo, "rev-parse", "HEAD")
    assert "Dry run" in commit(session, capsys, dry=True)
    assert git(repo, "rev-parse", "HEAD") == before
    assert git(repo, "diff", "--cached") == ""


def test_ai_failure_allows_explicit_retry_with_same_index(session, capsys, monkeypatch):
    repo, _, _ = session
    write(session)
    def fail(*args):
        raise hook.AiError("fixture failure")
    monkeypatch.setattr(hook, "generate_commit_message", fail)
    assert "nothing was committed" in commit(session, capsys, ai=True)
    assert git(repo, "diff", "--cached", "--name-only").strip() == "owned.txt"
    assert "Committed " in commit(session, capsys)


@pytest.mark.parametrize("mutation", ["worktree", "index", "head"])
def test_change_during_ai_generation_stops_commit(session, capsys, monkeypatch, mutation):
    repo, _, _ = session
    write(session)
    before = git(repo, "rev-parse", "HEAD")
    def generate(*args):
        if mutation == "head":
            git(repo, "commit", "--allow-empty", "--only", "-qm", "external")
        else:
            (repo / "owned.txt").write_text("external\n")
            if mutation == "index":
                git(repo, "add", "owned.txt")
        from types import SimpleNamespace
        return SimpleNamespace(subject="generated", body="")
    monkeypatch.setattr(hook, "generate_commit_message", generate)
    assert "Commit stopped:" in commit(session, capsys, ai=True)
    if mutation != "head":
        assert git(repo, "rev-parse", "HEAD") == before


def test_new_identity_does_not_inherit_receipts(session, capsys):
    repo, _, payload = session
    write(session)
    fork = hook._session_dir(str(repo), "fork")
    assert "Committed " not in commit((repo, fork, {**payload, "session_id": "fork"}), capsys)


def test_unstaging_after_ai_failure_invalidates_retry(session, capsys, monkeypatch):
    repo, _, _ = session
    write(session)
    def fail(*args):
        raise hook.AiError("fixture failure")
    monkeypatch.setattr(hook, "generate_commit_message", fail)
    assert "nothing was committed" in commit(session, capsys, ai=True)
    git(repo, "reset", "--", "owned.txt")
    before = git(repo, "rev-parse", "HEAD")
    assert "staged entries changed" in commit(session, capsys)
    assert git(repo, "rev-parse", "HEAD") == before
    assert git(repo, "diff", "--cached") == ""


def test_patch_move_owns_source_and_destination(session, capsys):
    repo, root, payload = session
    patch = "*** Begin Patch\n*** Update File: owned.txt\n*** Move to: [moved].txt\n@@\n-before\n+after\n*** End Patch"
    payload = {**payload, "tool_name": "apply_patch", "tool_input": {"command": patch}}
    hook._record_pre(payload, str(repo), root)
    (repo / "owned.txt").unlink()
    (repo / "[moved].txt").write_bytes(b"after\n")
    hook._record_post(payload, str(repo), root)
    assert "Committed " in commit((repo, root, payload), capsys)
    assert set(git(repo, "show", "--pretty=", "--name-only", "--no-renames").split()) == {"owned.txt", "[moved].txt"}


def test_unknown_shell_targets_stop(session, capsys):
    repo, root, payload = session
    payload = {**payload, "tool_name": "Bash", "tool_input": {"command": "git apply unknown.patch"}}
    hook._record_pre(payload, str(repo), root)
    (repo / "owned.txt").write_bytes(b"after\n")
    hook._record_post(payload, str(repo), root)
    before = git(repo, "rev-parse", "HEAD")
    assert "literal write targets" in commit((repo, root, payload), capsys)
    assert git(repo, "rev-parse", "HEAD") == before
    assert git(repo, "diff", "--cached") == ""
