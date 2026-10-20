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
    Path(__file__).resolve().parents[2]
    / "harness/building/issue-readers/issue_readers_hook.py"
)
spec = importlib.util.spec_from_file_location("issue_readers_hook", HOOK)
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




@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("skill", ["address", "review"])
@pytest.mark.parametrize("error", [
    hook.Blocked("prerequisite unavailable"),
    subprocess.TimeoutExpired(["git"], 30),
    RuntimeError("unexpected dependency failure"),
    OSError("dependency unavailable"),
])
def test_all_preparation_errors_block(provider, skill, error, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(sys, "argv", [str(HOOK), f"--{provider}"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "hook_event_name": "UserPromptSubmit", "prompt": f"${skill}-this 42", "cwd": str(tmp_path),
    })))

    def fail(*args):
        raise error

    monkeypatch.setattr(hook, f"build_{skill}_context", fail)
    if provider == "claude":
        with pytest.raises(SystemExit) as stopped:
            hook.main()
        assert stopped.value.code == 2
        captured = capsys.readouterr()
        assert not captured.out
        reason = captured.err
    else:
        hook.main()
        captured = capsys.readouterr()
        assert not captured.err
        result = json.loads(captured.out)
        assert result["decision"] == "block"
        reason = result["reason"]
    if isinstance(error, subprocess.TimeoutExpired):
        assert "timed out" in reason
    else:
        assert str(error) in reason


@pytest.mark.parametrize("raw", ["{", "[]", '{"hook_event_name":"UserPromptSubmit"}'])
def test_codex_invalid_input_blocks_instead_of_passing_through(raw, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", [str(HOOK), "--chatgpt"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(raw))
    hook.main()
    captured = capsys.readouterr()
    assert not captured.err
    result = json.loads(captured.out)
    assert result["decision"] == "block"
    assert result["reason"]


@pytest.mark.parametrize("prompt, argument", [
    ("/address-this 42", "42"),
    ("Please handle this with /address-this 42", "42"),
    (" $address-this 42, 51 \n", "42, 51"),
    ("[$address-this](C:/p/.agents/skills/address-this/SKILL.md) 42", "42"),
    ("/address-this", ""),
    ("/address-this\nFull issue text", "Full issue text"),
])
def test_invocation_argument_is_everything_after_the_reference(prompt, argument):
    assert hook.parse_invocation(prompt, hook.ADDRESS_INVOCATION) == argument


@pytest.mark.parametrize("prompt", [
    "Please address issue #42",
    "/address-thiss 42",
    "Explain what `/address-this` does",
])
def test_unrelated_prompts_are_ignored(prompt, tmp_path, monkeypatch, capsys):
    fake_github(monkeypatch, {})
    assert hook.parse_invocation(prompt, hook.ADDRESS_INVOCATION) is None
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
        "/address-this Fix the parser. Related to #123.", root, monkeypatch, capsys,
    )
    assert requested == []
    assert context




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
    error = blocked("/address-this 42", root, monkeypatch, capsys)
    assert "completely clean Git worktree" in error


def test_aboard_continuation_keeps_the_exact_dirty_address_handoff(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)})
    (root / "README.md").write_text("continued\n", encoding="utf-8")
    monkeypatch.setenv("ABOARD_WORKER_CONTINUATION", "1")

    context = run_hook("/address-this 42", root, monkeypatch, capsys)

    assert context


def test_ignored_files_do_not_count_as_dirty(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    (root / ".gitignore").write_text("build/\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "ignore"], cwd=root, check=True, capture_output=True)
    (root / "build").mkdir()
    (root / "build" / "artifact.js").write_text("x\n", encoding="utf-8")
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)})
    context = run_hook("/address-this 42", root, monkeypatch, capsys)
    assert context




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
    context = run_hook("/address-this 42, 51", root, monkeypatch, capsys)

    assert requested == [
        (REPOSITORY, 42), (REPOSITORY, 51),
        (REPOSITORY, 7), (REPOSITORY, 43), (REPOSITORY, 9),
    ]
    assert context


def test_full_urls_preload_from_their_identified_repositories(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    issues = {("other/repo", 7): issue(7, body="Elsewhere.", parent=3),
              ("other/repo", 3): issue(3, body="Elsewhere parent.")}
    requested = fake_github(monkeypatch, issues, repo_failure=True)
    context = run_hook(
        "/address-this https://github.com/other/repo/issues/7", root, monkeypatch, capsys,
    )
    assert requested == [("other/repo", 7), ("other/repo", 3)]
    assert context


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
    run_hook("/address-this 1", root, monkeypatch, capsys)
    assert requested == expected


def test_invalid_depth_blocks_with_an_actionable_message(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1)})
    monkeypatch.setenv(hook.DEPTH_VARIABLE, "deep")
    error = blocked("/address-this 1", root, monkeypatch, capsys)
    assert hook.DEPTH_VARIABLE in error


def test_related_issue_count_is_capped_and_disclosed(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    children = list(range(2, 2 + hook.MAX_RELATED_ISSUES + 10))
    issues = {(REPOSITORY, 1): issue(1, sub_issues=children)}
    for number in children:
        issues[(REPOSITORY, number)] = issue(number)
    requested = fake_github(monkeypatch, issues)
    context = run_hook("/address-this 1", root, monkeypatch, capsys)
    assert len(requested) == hook.MAX_RELATED_ISSUES + 1
    assert context


def test_only_the_newest_comments_are_rendered_and_omissions_disclosed(
    tmp_path, monkeypatch, capsys,
):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1, comments=40)})
    context = run_hook("/address-this 1", root, monkeypatch, capsys)
    assert context


def test_total_context_is_bounded_and_drops_are_disclosed(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    issues = {
        (REPOSITORY, 1): issue(1, body="x" * (hook.MAX_CONTEXT_CHARS + 1000), sub_issues=[2]),
        (REPOSITORY, 2): issue(2, body="second"),
    }
    fake_github(monkeypatch, issues)
    context = run_hook("/address-this 1", root, monkeypatch, capsys)
    assert context




def test_missing_primary_issue_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {})
    error = blocked("/address-this 42", root, monkeypatch, capsys)
    assert "could not find issue example/project#42" in error


def test_closed_primary_issue_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42, state="CLOSED")})
    error = blocked("/address-this 42", root, monkeypatch, capsys)
    assert "only addresses open issues" in error


def test_unauthenticated_gh_blocks(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 42): issue(42)}, repo_failure=True)
    error = blocked("/address-this 42", root, monkeypatch, capsys)
    assert "could not resolve the current GitHub repository" in error


def test_closed_related_issues_are_still_included(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    issues = {(REPOSITORY, 1): issue(1, parent=2),
              (REPOSITORY, 2): issue(2, state="CLOSED", body="closed parent")}
    fake_github(monkeypatch, issues)
    context = run_hook("/address-this 1", root, monkeypatch, capsys)
    assert context


def test_dangling_relations_are_skipped(tmp_path, monkeypatch, capsys):
    root = repository(tmp_path)
    fake_github(monkeypatch, {(REPOSITORY, 1): issue(1, body="see #99", sub_issues=[98])})
    context = run_hook("/address-this 1", root, monkeypatch, capsys)
    assert context




@pytest.mark.parametrize("platform", ["claude", "chatgpt"])
def test_skill_and_hook_install_for_both_products(platform, tmp_path):
    tools = discover()
    name = "issue-readers"
    target = Target.for_project(tmp_path / "project", platform=platform)
    CatalogueInstaller(
        {name: tools[name]}, target, ReceiptStore.load(tmp_path / "receipts.json"),
    ).reconcile({name})
    skill = target.destination_path("skills", "address-this/SKILL.md")
    assert skill.read_text(encoding="utf-8").split("---", 2)[2].strip()
    assert target.destination_path("hooks", "issue_readers_hook.py").exists()
    assert "issue_readers_hook.py" in target.settings_path.read_text(encoding="utf-8")
    assert (
        target.destination_path("skills", "address-this/agents/openai.yaml").exists()
        is (platform == "chatgpt")
    )
