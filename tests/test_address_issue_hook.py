"""Invocation parsing, worktree blocking, and bounded issue preloading."""

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
    Path(__file__).resolve().parents[1]
    / "harness/building/issues/shared/hooks/address_issue_UserPromptSubmit_hook.py"
)
spec = importlib.util.spec_from_file_location("address_issue_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

REPOSITORY = "example/project"


def repository(tmp_path):
    root = tmp_path / "checkout"
    root.mkdir()
    for arguments in (
        ["init", "-b", "main"],
        ["config", "user.email", "worker@example.com"],
        ["config", "user.name", "Worker"],
    ):
        subprocess.run(["git", *arguments], cwd=root, check=True, capture_output=True)
    (root / "README.md").write_text("tracked\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=root, check=True, capture_output=True)
    return root


def issue(number, *, body="", state="OPEN", parent=None, sub_issues=(), comments=0):
    shown = min(comments, hook.MAX_COMMENTS)
    return {
        "number": number,
        "title": f"Issue {number}",
        "body": body,
        "state": state,
        "author": {"login": "author"},
        "labels": {"nodes": [{"name": "bug"}]},
        "parent": None if parent is None else {"number": parent},
        "subIssues": {"nodes": [{"number": value} for value in sub_issues]},
        "comments": {
            "totalCount": comments,
            "nodes": [
                {"author": {"login": f"commenter{index}"}, "body": f"comment {index}"}
                for index in range(shown)
            ],
        },
    }


def fake_github(monkeypatch, issues, *, repo_failure=False):
    """Answer gh calls from a fixed issue table; run git for real."""
    real = subprocess.run
    requested = []

    def run(arguments, **kwargs):
        if arguments[0] != "gh":
            return real(arguments, **kwargs)
        if arguments[1] == "repo":
            if repo_failure:
                return subprocess.CompletedProcess(arguments, 1, "", "gh: not authenticated")
            return subprocess.CompletedProcess(arguments, 0, f"{REPOSITORY}\n", "")
        fields = dict(
            argument.split("=", 1) for argument in arguments if argument.count("=") == 1
        )
        key = (f"{fields['owner']}/{fields['repo']}", int(fields["number"]))
        requested.append(key)
        found = issues.get(key)
        payload = {"data": {"repository": {"issue": found}}}
        return subprocess.CompletedProcess(arguments, 0, json.dumps(payload), "")

    monkeypatch.setattr(hook.subprocess, "run", run)
    return requested


def run_hook(prompt, cwd, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": str(cwd),
    })))
    hook.main()
    captured = capsys.readouterr()
    assert not captured.err
    return json.loads(captured.out)["hookSpecificOutput"]["additionalContext"] if captured.out else None


def blocked(prompt, cwd, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": str(cwd),
    })))
    with pytest.raises(SystemExit) as exit_info:
        hook.main()
    assert exit_info.value.code == 2
    return capsys.readouterr().err


# --- invocation parsing ---------------------------------------------------


@pytest.mark.parametrize("prompt, argument", [
    ("/address-issue 42", "42"),
    (" $address-issue 42, 51 \n", "42, 51"),
    ("[$address-issue](C:/p/.agents/skills/address-issue/SKILL.md) 42", "42"),
    ("/address-issue", ""),
    ("/address-issue\nFull issue text", "Full issue text"),
])
def test_invocation_argument_is_everything_after_the_reference(prompt, argument):
    assert hook.parse_invocation(prompt) == argument


@pytest.mark.parametrize("prompt", [
    "Please address issue #42",
    "/address-issues 42",
    "Explain what /address-issue does",
])
def test_unrelated_prompts_are_ignored(prompt, tmp_path, monkeypatch, capsys):
    fake_github(monkeypatch, {})
    assert hook.parse_invocation(prompt) is None
    assert run_hook(prompt, tmp_path, monkeypatch, capsys) is None


@pytest.mark.parametrize("argument, expected", [
    ("42", [(REPOSITORY, 42)]),
    ("42, 51", [(REPOSITORY, 42), (REPOSITORY, 51)]),
    ("https://github.com/other/repo/issues/7", [("other/repo", 7)]),
    (
        "https://github.com/other/repo/issues/7, https://github.com/third/repo/issues/8",
        [("other/repo", 7), ("third/repo", 8)],
    ),
])
def test_strict_reference_mode_accepts_only_whole_reference_arguments(argument, expected):
    assert hook.strict_references(argument, REPOSITORY) == expected


@pytest.mark.parametrize("argument", [
    "",
    "Fix the parser. See #123 for background.",
    "#42",
    "42 and 51",
    "0",
    "-1",
    "42, please",
    "https://github.com/other/repo/pull/7",
])
def test_arbitrary_text_never_enters_reference_mode(argument):
    assert hook.strict_references(argument, REPOSITORY) is None


def test_supplied_issue_text_containing_a_reference_triggers_no_lookup(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    requested = fake_github(monkeypatch, {(REPOSITORY, 123): issue(123)})
    context = run_hook(
        "/address-issue Fix the parser. Related to #123.", root, monkeypatch, capsys,
    )
    assert requested == []
    assert "verified clean" in context
    assert "literal supplied content" in context


# --- clean worktree -------------------------------------------------------


@pytest.mark.parametrize("dirty", ["staged", "unstaged", "untracked"])
def test_any_pre_existing_change_blocks_before_model_invocation(
    dirty, tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)})
    if dirty == "untracked":
        (root / "scratch.txt").write_text("new\n", encoding="utf-8")
    else:
        (root / "README.md").write_text("changed\n", encoding="utf-8")
        if dirty == "staged":
            subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    error = blocked("/address-issue 42", root, monkeypatch, capsys)
    assert "completely clean Git worktree" in error


def test_ignored_files_do_not_count_as_dirty(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    (root / ".gitignore").write_text("build/\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "ignore"], cwd=root, check=True, capture_output=True)
    (root / "build").mkdir()
    (root / "build" / "artifact.js").write_text("x\n", encoding="utf-8")
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)})
    context = run_hook("/address-issue 42", root, monkeypatch, capsys)
    assert "verified clean" in context


# --- preloaded context ----------------------------------------------------


def test_bare_numbers_preload_full_context_from_the_current_repository(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    issues = {
        (REPOSITORY, 42): issue(42, body="Body of 42. Blocked by #9.", parent=7,
                                sub_issues=[43], comments=2),
        (REPOSITORY, 51): issue(51, body="Body of 51."),
        (REPOSITORY, 7): issue(7, body="Parent body."),
        (REPOSITORY, 43): issue(43, body="Sub body.", state="CLOSED"),
        (REPOSITORY, 9): issue(9, body="Referenced body."),
    }
    requested = fake_github(monkeypatch, issues)
    context = run_hook("/address-issue 42, 51", root, monkeypatch, capsys)

    assert requested == [
        (REPOSITORY, 42), (REPOSITORY, 51),
        (REPOSITORY, 7), (REPOSITORY, 43), (REPOSITORY, 9),
    ]
    assert f"## Issue {REPOSITORY}#42: Issue 42" in context
    assert f"## Parent issue {REPOSITORY}#7" in context
    assert f"## Sub-issue {REPOSITORY}#43" in context
    assert f"## Referenced issue {REPOSITORY}#9" in context
    assert "- Author: @author" in context
    assert "- Labels: bug" in context
    assert "#### @commenter0" in context
    assert "Body of 42." in context


def test_full_urls_preload_from_their_identified_repositories(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    issues = {("other/repo", 7): issue(7, body="Elsewhere.", parent=3),
              ("other/repo", 3): issue(3, body="Elsewhere parent.")}
    requested = fake_github(monkeypatch, issues, repo_failure=True)
    context = run_hook(
        "/address-issue https://github.com/other/repo/issues/7", root, monkeypatch, capsys,
    )
    assert requested == [("other/repo", 7), ("other/repo", 3)]
    assert "## Issue other/repo#7" in context
    assert "## Parent issue other/repo#3" in context


@pytest.mark.parametrize("depth, expected", [
    ("0", [(REPOSITORY, 1)]),
    ("1", [(REPOSITORY, 1), (REPOSITORY, 2)]),
    ("2", [(REPOSITORY, 1), (REPOSITORY, 2), (REPOSITORY, 3)]),
    (None, [(REPOSITORY, 1), (REPOSITORY, 2)]),
])
def test_relation_depth_is_configurable_and_defaults_to_one(
    depth, expected, tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    issues = {
        (REPOSITORY, 1): issue(1, sub_issues=[2]),
        (REPOSITORY, 2): issue(2, sub_issues=[3]),
        (REPOSITORY, 3): issue(3, sub_issues=[4]),
        (REPOSITORY, 4): issue(4),
    }
    requested = fake_github(monkeypatch, issues)
    if depth is None:
        monkeypatch.delenv(hook.DEPTH_VARIABLE, raising=False)
    else:
        monkeypatch.setenv(hook.DEPTH_VARIABLE, depth)
    run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert requested == expected


def test_invalid_depth_blocks_with_an_actionable_message(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1)})
    monkeypatch.setenv(hook.DEPTH_VARIABLE, "deep")
    error = blocked("/address-issue 1", root, monkeypatch, capsys)
    assert hook.DEPTH_VARIABLE in error


def test_related_issue_count_is_capped_and_disclosed(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    children = list(range(2, 2 + hook.MAX_RELATED_ISSUES + 10))
    issues = {(REPOSITORY, 1): issue(1, sub_issues=children)}
    for number in children:
        issues[(REPOSITORY, number)] = issue(number)
    requested = fake_github(monkeypatch, issues)
    context = run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert len(requested) == hook.MAX_RELATED_ISSUES + 1
    assert "## Omitted context" in context
    assert f"{hook.MAX_RELATED_ISSUES}-issue limit" in context


def test_only_the_newest_comments_are_rendered_and_omissions_disclosed(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1, comments=40)})
    context = run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert f"### Comments ({hook.MAX_COMMENTS} of 40)" in context
    assert "20 older comment(s) omitted." in context


def test_total_context_is_bounded_and_drops_are_disclosed(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    issues = {
        (REPOSITORY, 1): issue(1, body="x" * (hook.MAX_CONTEXT_CHARS + 1000), sub_issues=[2]),
        (REPOSITORY, 2): issue(2, body="second"),
    }
    fake_github(monkeypatch, issues)
    context = run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert f"## Sub-issue {REPOSITORY}#2" not in context
    assert f"Omitted for context size: {REPOSITORY}#2" in context


# --- failing references ---------------------------------------------------


def test_missing_primary_issue_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {})
    error = blocked("/address-issue 42", root, monkeypatch, capsys)
    assert "could not find issue example/project#42" in error


def test_closed_primary_issue_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42, state="CLOSED")})
    error = blocked("/address-issue 42", root, monkeypatch, capsys)
    assert "only addresses open issues" in error


def test_unauthenticated_gh_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)}, repo_failure=True)
    error = blocked("/address-issue 42", root, monkeypatch, capsys)
    assert "could not resolve the current GitHub repository" in error


def test_closed_related_issues_are_still_included(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    issues = {(REPOSITORY, 1): issue(1, parent=2),
              (REPOSITORY, 2): issue(2, state="CLOSED", body="closed parent")}
    fake_github(monkeypatch, issues)
    context = run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert "closed parent" in context


def test_dangling_relations_are_skipped(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1, body="see #99", sub_issues=[98])})
    context = run_hook("/address-issue 1", root, monkeypatch, capsys)
    assert "#98" in context  # listed as a sub-issue of the primary
    assert "## Sub-issue" not in context
    assert "## Referenced issue" not in context


# --- installation ---------------------------------------------------------


@pytest.mark.parametrize("platform", ["claude", "chatgpt"])
def test_skill_and_hook_install_for_both_products(platform, tmp_path):
    tools = discover()
    name = "issues"
    target = Target.for_project(tmp_path / "project", platform=platform)
    CatalogueInstaller(
        {name: tools[name]}, target, ReceiptStore.load(tmp_path / "receipts.json"),
    ).reconcile({name})
    skill = target.destination_path("skills", "address-issue/SKILL.md")
    assert skill.read_text(encoding="utf-8").rstrip().endswith("---")
    assert target.destination_path("hooks", "address_issue_UserPromptSubmit_hook.py").exists()
    assert "address_issue_UserPromptSubmit_hook.py" in target.settings_path.read_text(encoding="utf-8")
    assert (
        target.destination_path("skills", "address-issue/agents/openai.yaml").exists()
        is (platform == "chatgpt")
    )
