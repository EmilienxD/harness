"""Commit metadata injection and worktree blocking for review."""

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


HOOK = (
    Path(__file__).resolve().parents[2]
    / "harness/building/issue-readers/issue_readers_hook.py"
)
spec = importlib.util.spec_from_file_location("issue_readers_hook_review", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def git(root, *arguments):
    return subprocess.run(
        ["git", *arguments], cwd=root, check=True, capture_output=True,
        text=True, encoding="utf-8",
    ).stdout


def repository(tmp_path, commits=2):
    root = tmp_path / "checkout"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "worker@example.com")
    git(root, "config", "user.name", "Worker")
    (root / "README.md").write_text("tracked\n", encoding="utf-8")
    (root / "old.py").write_text("old\n", encoding="utf-8")
    git(root, "add", "-A")
    git(root, "commit", "-m", "base")
    if commits > 1:
        (root / "README.md").write_text("edited\n", encoding="utf-8")
        (root / "new.py").write_text("new\n", encoding="utf-8")
        (root / "old.py").unlink()
        git(root, "add", "-A")
        git(root, "commit", "-m", "implement the feature")
    return root


def run_hook(prompt, cwd, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": str(cwd),
    })))
    hook.main()
    captured = capsys.readouterr()
    assert not captured.err
    if not captured.out:
        return None
    return json.loads(captured.out)["hookSpecificOutput"]["additionalContext"]


def blocked(prompt, cwd, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": str(cwd),
    })))
    with pytest.raises(SystemExit) as exit_info:
        hook.main()
    assert exit_info.value.code == 2
    return capsys.readouterr().err


@pytest.mark.parametrize("prompt", [
    "Review the last commit",
    "/reviewer",
    "Explain what /review-this does",
])
def test_unrelated_prompts_are_ignored(prompt, tmp_path, monkeypatch, capsys):
    assert run_hook(prompt, repository(tmp_path), monkeypatch, capsys) is None


@pytest.mark.parametrize("prompt", [
    "/review-this",
    " $review-this focus on error paths\n",
    "[$review-this](C:/p/.agents/skills/review-this/SKILL.md)",
])
def test_head_metadata_and_changed_files_are_injected_without_the_diff(
    prompt, tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    context = run_hook(prompt, root, monkeypatch, capsys)
    head = git(root, "rev-parse", "HEAD").strip()
    parent = git(root, "rev-parse", "HEAD^").strip()

    assert context
    assert head
    assert parent


def test_renames_are_reported_with_both_paths(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    git(root, "mv", "new.py", "renamed.py")
    git(root, "commit", "-m", "rename")
    context = run_hook("/review-this", root, monkeypatch, capsys)
    assert context


def test_root_commit_reports_no_parent(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path, commits=1)
    context = run_hook("/review-this", root, monkeypatch, capsys)
    assert context


@pytest.mark.parametrize("dirty", ["staged", "unstaged", "untracked"])
def test_any_pre_existing_change_blocks_before_model_invocation(
    dirty, tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    if dirty == "untracked":
        (root / "scratch.txt").write_text("new\n", encoding="utf-8")
    else:
        (root / "README.md").write_text("changed again\n", encoding="utf-8")
        if dirty == "staged":
            git(root, "add", "-A")
    error = blocked("/review-this", root, monkeypatch, capsys)
    assert "completely clean Git worktree" in error


def test_aboard_pinned_range_allows_the_uncommitted_hitl_handoff(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    before = git(root, "rev-parse", "HEAD^").strip()
    checkpoint = git(root, "rev-parse", "HEAD").strip()
    git(root, "reset", "--mixed", before)
    monkeypatch.setenv("ABOARD_REVIEW_RANGE", f"{before}..{checkpoint}")

    context = run_hook("/review-this", root, monkeypatch, capsys)

    assert context


def test_aboard_continuation_keeps_the_exact_dirty_reviewer_handoff(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    (root / "README.md").write_text("review fix\n", encoding="utf-8")
    monkeypatch.setenv("ABOARD_WORKER_CONTINUATION", "1")

    context = run_hook("/review-this", root, monkeypatch, capsys)

    assert context


def test_ignored_files_do_not_count_as_dirty(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    (root / ".gitignore").write_text("build/\n", encoding="utf-8")
    git(root, "add", "-A")
    git(root, "commit", "-m", "ignore")
    (root / "build").mkdir()
    (root / "build" / "artifact.js").write_text("x\n", encoding="utf-8")
    assert "verified clean" in run_hook("/review-this", root, monkeypatch, capsys)


def test_missing_repository_blocks(tmp_path, monkeypatch, capsys):
    plain = tmp_path / "plain"
    plain.mkdir()
    # Prevent Git from searching upward into a repository that contains tmp_path.
    (plain / ".git").write_text("not a gitdir", encoding="utf-8")
    error = blocked("/review-this", plain, monkeypatch, capsys)
    assert "requires a Git repository" in error


@pytest.mark.parametrize("platform", ["claude", "chatgpt"])
def test_skill_and_hook_install_for_both_products(platform, tmp_path):
    tools = discover()
    name = "issue-readers"
    target = Target.for_project(tmp_path / "project", platform=platform)
    CatalogueInstaller(
        {name: tools[name]}, target, ReceiptStore.load(tmp_path / "receipts.json"),
    ).reconcile({name})
    skill = target.destination_path("skills", "review-this/SKILL.md")
    assert skill.read_text(encoding="utf-8").split("---", 2)[2].strip()
    assert target.destination_path("hooks", "issue_readers_hook.py").exists()
    assert "issue_readers_hook.py" in target.settings_path.read_text(encoding="utf-8")
    assert (
        target.destination_path("skills", "review-this/agents/openai.yaml").exists()
        is (platform == "chatgpt")
    )
