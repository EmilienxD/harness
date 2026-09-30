"""Cleanup facts at the invocation hook boundary; Git runs against real repositories."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

HOOK = Path(__file__).parents[2] / "harness/productivity/cleanup-git/cleanup_git_hook.py"


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def test_cleanup_invocation_collects_every_branch_and_worktree_without_mutating(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    (root / ".gitignore").write_text("ignored\n")
    (root / "source.txt").write_text("baseline\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "baseline")
    git(root, "branch", "merged")
    dirty = tmp_path / "dirty"
    detached = tmp_path / "detached"
    missing = tmp_path / "missing"
    git(root, "worktree", "add", "-b", "unfinished", str(dirty))
    (dirty / "feature.txt").write_text("feature\n")
    git(dirty, "add", ".")
    git(dirty, "commit", "-m", "unprocessed feature")
    (dirty / "source.txt").write_text("uncommitted\n")
    (dirty / "untracked.txt").write_text("new\n")
    (dirty / "ignored").write_text("secret\n")
    git(root, "worktree", "add", "--detach", str(detached))
    git(root, "worktree", "add", "-b", "missing-branch", str(missing))
    shutil.rmtree(missing)
    codex = tmp_path / "codex"
    codex.mkdir()
    trust = f'[projects.{json.dumps(str(missing))}]\ntrust_level = "trusted"\n'
    (codex / "config.toml").write_text(trust)
    monkeypatch.setenv("CODEX_HOME", str(codex))
    spec = importlib.util.spec_from_file_location("cleanup_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real_run = module.subprocess.run

    def command(args, **kwargs):
        if args[0] != "gh":
            return real_run(args, **kwargs)
        if args[1:3] == ["repo", "view"]:
            return subprocess.CompletedProcess(args, 0, 'fixture/repo\n', '')
        if "repos/fixture/repo/pulls?state=all&per_page=100" in args:
            data = [[{"number": 10, "state": "closed", "merged_at": "2026-01-01T00:00:00Z", "head": {"ref": "merged", "repo": {"full_name": "fixture/repo"}}, "html_url": "https://github.test/pr/10"}]]
        else:
            assert "repos/fixture/repo/issues?state=open&labels=%5BAI%5D-in-progress&per_page=100" in args
            data = [[{"number": 42, "title": "Unfinished", "html_url": "https://github.test/42"}]]
        return subprocess.CompletedProcess(args, 0, json.dumps(data), '')

    monkeypatch.setattr(module.subprocess, "run", command)
    before = git(root, "worktree", "list", "--porcelain")
    output = module.handle({"hook_event_name": "UserPromptSubmit", "prompt": "/cleanup-git --target main", "cwd": str(root)})
    facts = json.loads(output["hookSpecificOutput"]["additionalContext"])
    assert {b["name"] for b in facts["branches"]} == {"main", "merged", "unfinished", "missing-branch"}
    branches = {b["name"]: b for b in facts["branches"]}
    assert branches["merged"]["pull_requests"][0]["state"] == "MERGED"
    assert branches["unfinished"]["target_comparison"] == {"ahead": 1, "behind": 0}
    worktrees = {w["branch"]: w for w in facts["worktrees"]}
    assert worktrees[None]["detached"]
    assert worktrees["missing-branch"]["exists"] is False
    assert {p["path"] for p in worktrees["unfinished"]["changes"]} == {"source.txt", "untracked.txt"}
    assert all(p["modified_at"] for p in worktrees["unfinished"]["changes"])
    assert worktrees["unfinished"]["latest_file_change"]
    assert facts["in_progress_issues"][0]["number"] == 42
    assert facts["missing_trust_entries"][0]["path"] == str(missing)
    assert git(root, "worktree", "list", "--porcelain") == before
    assert (codex / "config.toml").read_text() == trust
    assert git(dirty, "status", "--porcelain") == "M source.txt\n?? untracked.txt"
    assert module.handle({"hook_event_name": "Stop", "prompt": "/cleanup-git", "cwd": str(root)}) is None
    assert module.handle({"prompt": "Please explain cleanup-git", "cwd": str(root)}) is None
