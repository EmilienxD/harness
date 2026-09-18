"""Exercise the installed hook protocol against real disposable Git repositories."""
import json
from pathlib import Path
import subprocess
import sys

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


HOOK = Path(__file__).resolve().parents[2] / "harness/guards/remove-anthropic-coauthor/remove_anthropic_coauthor_hook.py"


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True,
        encoding="utf-8", check=True,
    ).stdout


def setup_repo(repo):
    repo.mkdir(exist_ok=True)
    git(repo, "init")
    git(repo, "config", "user.name", "Test Author")
    git(repo, "config", "user.email", "author@example.com")
    git(repo, "config", "commit.gpgSign", "false")
    git(repo, "config", "core.hooksPath", str(repo / "no-hooks"))
    (repo / "file.txt").write_text("committed\n")
    git(repo, "add", ".")


def invoke(repo, output, command="git commit -m message", **overrides):
    payload = {
        "hook_event_name": "PostToolUse", "tool_name": "Bash", "cwd": str(repo),
        "tool_input": {"command": command}, "tool_response": {"stdout": output},
    }
    payload.update(overrides)
    return subprocess.run(
        [sys.executable, str(HOOK), "--claude"], input=json.dumps(payload),
        capture_output=True, text=True, encoding="utf-8",
    )


def test_removes_dynamic_claude_trailer_and_preserves_index_and_authorship(tmp_path):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", "Ship feature\n\nCo-Authored-By: Alice <alice@example.com>\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>")
    tree = git(tmp_path, "rev-parse", "HEAD^{tree}")
    author = git(tmp_path, "show", "-s", "--format=%an <%ae> %aI")
    (tmp_path / "file.txt").write_text("staged\n")
    git(tmp_path, "add", ".")
    staged = git(tmp_path, "diff", "--cached")
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "show", "-s", "--format=%B").rstrip() == "Ship feature\n\nCo-Authored-By: Alice <alice@example.com>"
    assert git(tmp_path, "rev-parse", "HEAD^{tree}") == tree
    assert git(tmp_path, "show", "-s", "--format=%an <%ae> %aI") == author
    assert git(tmp_path, "diff", "--cached") == staged
    assert json.loads(result.stdout)["hookSpecificOutput"]["hookEventName"] == "PostToolUse"


@pytest.mark.parametrize("trailer", [
    "co-authored-by: Claude Sonnet 9 <noreply@anthropic.com>",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
])
def test_removes_other_models_and_case_variations(tmp_path, trailer):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", "Feature\n\n" + trailer)
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "show", "-s", "--format=%B").rstrip() == "Feature"


@pytest.mark.parametrize("message", [
    "Feature\n\nCo-Authored-By: Claude <claude@example.com>",
    "Feature\n\nCo-Authored-By: Alice <noreply@anthropic.com>",
    "Example\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\nKeep this example.",
    "Example\n\nHere is a trailer example:\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
])
def test_preserves_other_attribution_and_body_examples(tmp_path, message):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", message)
    head = git(tmp_path, "rev-parse", "HEAD")
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "rev-parse", "HEAD") == head


@pytest.mark.parametrize("command", ['git -C "child repo" commit -m message', 'cd "child repo" && git commit -m message'])
def test_finds_repository_selected_by_command(tmp_path, command):
    repo = tmp_path / "child repo"
    setup_repo(repo)
    output = git(repo, "commit", "-m", "Feature\n\nCo-Authored-By: Claude Haiku 8 <noreply@anthropic.com>")
    result = invoke(tmp_path, output, command)
    assert result.returncode == 0, result.stderr
    assert git(repo, "show", "-s", "--format=%B").rstrip() == "Feature"


def test_does_not_rewrite_head_when_tool_reports_an_older_commit(tmp_path):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", "First\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
    git(tmp_path, "commit", "--allow-empty", "-m", "Later\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
    head = git(tmp_path, "rev-parse", "HEAD")
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "rev-parse", "HEAD") == head


def test_amends_empty_commit_without_changing_parents(tmp_path):
    setup_repo(tmp_path)
    git(tmp_path, "commit", "-m", "First")
    output = git(tmp_path, "commit", "--allow-empty", "-m", "Empty\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
    parents = git(tmp_path, "show", "-s", "--format=%P")
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "show", "-s", "--format=%B").rstrip() == "Empty"
    assert git(tmp_path, "show", "-s", "--format=%P") == parents


@pytest.mark.parametrize("overrides", [
    {"tool_name": "Read"},
    {"hook_event_name": "PreToolUse"},
    {"tool_response": {"stdout": "", "interrupted": True}},
    {"tool_response": {}},
    {"tool_input": None},
])
def test_ignores_unrelated_or_incomplete_tool_events(tmp_path, overrides):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", "Feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
    head = git(tmp_path, "rev-parse", "HEAD")
    result = invoke(tmp_path, output, **overrides)
    assert result.returncode == 0, result.stderr
    assert git(tmp_path, "rev-parse", "HEAD") == head


def test_installs_claude_post_tool_hook(tmp_path):
    tool = discover()["remove-anthropic-coauthor"]
    target = Target.for_project(tmp_path, platform="claude")
    receipts = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller({tool.name: tool}, target, receipts).reconcile({tool.name})
    assert (tmp_path / ".claude/hooks/remove_anthropic_coauthor_hook.py").is_file()
    config = json.loads((tmp_path / ".claude/settings.json").read_text(encoding="utf-8"))
    assert config["hooks"]["PostToolUse"][0]["matcher"] == "Bash|PowerShell"
    assert not (tmp_path / ".codex").exists()


def test_amended_commit_message_preserves_lf_bytes(tmp_path):
    setup_repo(tmp_path)
    output = git(tmp_path, "commit", "-m", "Feature\n\nCo-Authored-By: Alice <alice@example.com>\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>")
    result = invoke(tmp_path, output)
    assert result.returncode == 0, result.stderr
    commit = subprocess.run(
        ["git", "-C", str(tmp_path), "cat-file", "commit", "HEAD"],
        capture_output=True, check=True,
    ).stdout
    assert commit.split(b"\n\n", 1)[1] == b"Feature\n\nCo-Authored-By: Alice <alice@example.com>\n"
