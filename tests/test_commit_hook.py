"""Regression tests for the /commit UserPromptSubmit hook's gitignore handling.

The hook parses the session transcript for the files Claude wrote and stages
exactly those. Files under a gitignored path (an agent-scratch dir like
`.issues-gateway/`, build output, ...) must be *reported* as skipped, never
staged -- otherwise `/commit --dry` claims it "Would stage" a file git then
refuses, and a real `/commit` whose only write is ignored dies on a spurious
`git add failed` (git add exits 1 on an ignored pathspec).

These run the hook's own helpers against a real throwaway repo, so they need
git on PATH (declared by the tool's `requires`).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = (
    Path(__file__).resolve().parent.parent
    / "harness" / "commit" / "hooks" / "commit_UserPromptSubmit_hook.py"
)

sys.path.insert(0, str(HOOK.parent))
import commit_UserPromptSubmit_hook as hook  # noqa: E402


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    (repo / "seed.md").write_text("seed\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    # The directory the agent scribbles in, and which the user gitignores.
    (repo / ".gitignore").write_text(".issues-gateway/\n")
    (repo / ".issues-gateway" / "abc").mkdir(parents=True)
    (repo / ".issues-gateway" / "abc" / "issue-0.md").write_text("draft\n")
    return repo


def _write_record(path):
    return {
        "type": "assistant",
        "cwd": str(path.parent),
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": f"id-{path.name}",
                    "name": "Write",
                    "input": {"file_path": str(path)},
                }
            ]
        },
    }


def _transcript(*paths):
    fh, name = __import__("tempfile").mkstemp(suffix=".jsonl")
    with os.fdopen(fh, "w", encoding="utf-8") as out:
        for p in paths:
            out.write(json.dumps(_write_record(Path(p))) + "\n")
    return name


def test_ignored_writes_are_not_staged_and_are_reported(repo):
    track = repo / "TEST.md"
    track.write_text("real change\n")
    ignored_existing = repo / ".issues-gateway" / "abc" / "issue-0.md"
    ignored_deleted = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(track, ignored_existing, ignored_deleted)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan is not None
    # Only the real (non-ignored) write survived the filter.
    assert scan.paths == [os.path.normpath(str(track))]
    # Both ignored paths are reported as skipped, not silently dropped.
    assert set(scan.ignored) == {
        os.path.normpath(str(ignored_existing)),
        os.path.normpath(str(ignored_deleted)),
    }

    # ... and the same filter is what a real /commit stages with.
    present, deletions, unmatched = hook.resolve_stage_set(scan.paths, str(repo))
    assert [os.path.basename(p) for p in present] == ["TEST.md"]
    assert deletions == [] and unmatched == []


def test_ignored_deleted_file_still_ignored_not_reported_missing(repo):
    """A gitignored write to a file that no longer exists must read as
    'gitignored', not as the baffling 'no longer exist' the bug produced."""
    gone = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(gone)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan.paths == []  # nothing left to stage
    assert scan.ignored == [os.path.normpath(str(gone))]
    # resolve_stage_set never even sees it.
    present, deletions, unmatched = hook.resolve_stage_set(scan.paths, str(repo))
    assert present == [] and deletions == [] and unmatched == []


def test_tracked_file_inside_ignored_dir_still_stages(repo):
    """gitignore ignores *untracked* files only; an ignored dir's tracked file
    Claude actually edited is a real change and must not be filtered out."""
    tracked_ignored = repo / ".issues-gateway" / "abc" / "issue-0.md"
    _git(repo, "add", "-f", ".issues-gateway/abc/issue-0.md")
    _git(repo, "commit", "-qm", "track it")
    tracked_ignored.write_text("edited\n")

    transcript = _transcript(tracked_ignored)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan.paths == [os.path.normpath(str(tracked_ignored))]
    assert scan.ignored == []


def test_only_ignored_writes_stage_nothing(repo):
    """The pre-fix failure: with nothing but an ignored write, `git add` was
    handed an ignored pathspec and exited 1, failing the whole commit."""
    gone = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(gone)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    present, deletions, _ = hook.resolve_stage_set(scan.paths, str(repo))
    assert present + deletions == []
    # stage_paths on the filtered set is a no-op rather than an error.
    result, targets = hook.stage_paths(scan.paths, str(repo))
    assert result is None and targets == []
    assert _git(repo, "status", "--porcelain", "--", ".issues-gateway").strip() == ""
