"""Cleanup facts at the invocation hook boundary; Git runs against real repositories."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import load_tool
from harness_cli.receipts import ReceiptStore

HOOK = Path(__file__).parents[2] / "harness/productivity/cleanup-git/cleanup_git_hook.py"
SCRIPT = HOOK.with_name("cleanup_git.py")


def inventory(root):
    return load_script().collect(root)


def load_script():
    spec = importlib.util.spec_from_file_location("cleanup_inventory", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gh_available(monkeypatch):
    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name: "gh" if name == "gh" else real_which(name))


def test_inventory_output_uses_titled_toon_tables_and_preserves_nested_facts():
    facts = {
        "target": "main", "snapshot_consistent": True,
        "branches": [
            {"name": "merged", "merged_into_target": True, "reasons": []},
            {"name": "unfinished", "merged_into_target": None, "reasons": ["inspection-failed"]},
        ],
        "worktrees": [{"path": "/repo", "clean": False, "changes": [
            {"path": "a,b.txt", "status": "??"},
            {"path": "c.txt", "status": " M"},
        ]}],
    }
    assert load_script().render_inventory(facts) == (
        "# Git cleanup inventory\n"
        "target: main\n"
        "snapshot_consistent: true\n"
        "branches[2]{name,merged_into_target}:\n"
        "  merged,true\n"
        "  unfinished,null\n"
        "branch_details[2]:\n"
        "  - name: merged\n"
        "    reasons[0]:\n"
        "  - name: unfinished\n"
        "    reasons[1]: inspection-failed\n"
        "worktrees[1]{path,clean}:\n"
        "  /repo,false\n"
        "worktree_details[1]:\n"
        "  - path: /repo\n"
        "    changes[2]{path,status}:\n"
        '      "a,b.txt",??\n'
        '      c.txt," M"'
    )


@pytest.mark.parametrize("value,encoded", [
    ("true", '"true"'), ("05", '"05"'), ("+1e-6", '"+1e-6"'),
    ("", '""'), ("-topic", '"-topic"'), ("# title", '"# title"'),
    ("a[b]{c}", '"a[b]{c}"'), ("café.txt", "café.txt"),
    ('C:\\repo\\a,b".txt\n\t\r\b\f', '"C:\\\\repo\\\\a,b\\".txt\\n\\t\\r\\u0008\\u000c"'),
    (r"literal\n\b", '"literal\\\\n\\\\b"'),
])
def test_inventory_output_quotes_ambiguous_strings_and_escapes_file_names(value, encoded):
    assert load_script().render_inventory({"files": [value]}) == (
        "# Git cleanup inventory\nfiles[1]: " + encoded
    )


def test_script_emits_utf8_toon_with_complete_file_entries(tmp_path):
    root = tmp_path / "répo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    for index in range(8):
        (root / f"café-{index}.txt").write_text("new\n")
    result = subprocess.run([sys.executable, str(SCRIPT)], cwd=root, capture_output=True,
                            env={**os.environ, "PYTHONIOENCODING": "ascii"})
    assert result.returncode == 0, result.stderr
    context = result.stdout.decode("utf-8")
    assert context.startswith("# Git cleanup inventory\n")
    assert "\r" not in context
    assert "    changes[8]{path,status,modified_at}:" in context
    assert all(f"café-{index}.txt,??," in context for index in range(8))


def test_script_reports_local_merge_evidence_without_changing_refs(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    git(root, "branch", "merged")
    before = git(root, "show-ref")
    facts = inventory(root)
    branches = {b["name"]: b for b in facts["branches"]}
    assert branches["merged"]["merged_into_target"] is True
    assert branches["merged"]["decision"] == "eligible"
    assert branches["main"]["decision"] == "preserve"
    assert facts["github_status"] in {"unknown", "unavailable"}
    assert facts["common_dir"]
    assert facts["collected_at"]
    assert git(root, "show-ref") == before


def test_inventory_preserves_worktrees_with_local_files_locks_and_operations(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    (root / ".gitignore").write_text(".env\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "base")
    linked = tmp_path / "linked with spaces"
    git(root, "worktree", "add", "-b", "merged", str(linked))
    (linked / ".env").write_text("secret\n")
    git(root, "worktree", "lock", str(linked))
    git_dir = Path(git(linked, "rev-parse", "--absolute-git-dir"))
    (git_dir / "CHERRY_PICK_HEAD").write_text(git(root, "rev-parse", "HEAD") + "\n")
    facts = inventory(root)
    checkout = next(w for w in facts["worktrees"] if w["branch"] == "merged")
    assert checkout["locked"] is True
    assert checkout["status_known"] is True
    assert checkout["clean"] is False
    assert checkout["ignored"] == [{"path": ".env", "status": "!!"}]
    assert checkout["operations"] == ["cherry-pick"]
    assert checkout["removal_blockers"] == ["locked", "ignored-files", "operation-in-progress"]
    assert next(b for b in facts["branches"] if b["name"] == "merged")["decision"] == "preserve"


def test_failed_git_checks_remain_unknown_instead_of_clean_or_unmerged(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    git(root, "branch", "merged")
    module = load_script()
    real_run = subprocess.run

    def failed_checks(args, **kwargs):
        if args[:2] in (["git", "status"], ["git", "merge-base"]):
            return subprocess.CompletedProcess(args, 128, "", "inspection unavailable")
        return real_run(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", failed_checks)
    facts = module.collect(root)
    assert facts["worktrees"][0]["clean"] is None
    assert facts["worktrees"][0]["status_known"] is False
    assert "inspection-failed" in facts["worktrees"][0]["removal_blockers"]
    branch = next(b for b in facts["branches"] if b["name"] == "merged")
    assert branch["merged_into_target"] is None
    assert branch["decision"] == "unresolved"
    assert branch["errors"]
    assert facts["errors"]


def test_no_argument_inventory_includes_all_files_and_refreshes_every_branch(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "commit", "--allow-empty", "-m", "base")
    linked = tmp_path / "feature"
    git(root, "worktree", "add", "-b", "feature", str(linked))
    for index in range(65):
        (linked / f"file-{index}.txt").write_text("new\n")
    first = inventory(root)
    assert {b["name"] for b in first["branches"]} == {"feature", "main"}
    assert {w["branch"] for w in first["worktrees"]} == {"feature", "main"}
    feature = next(b for b in first["branches"] if b["name"] == "feature")
    checkout = next(w for w in first["worktrees"] if w["branch"] == "feature")
    assert len(checkout["changes"]) == 65
    assert checkout["changes_omitted"] == 0
    git(linked, "add", ".")
    git(linked, "commit", "-m", "unfinished work")
    (linked / "local.txt").write_text("later\n")
    second = inventory(linked)
    refreshed = next(b for b in second["branches"] if b["name"] == "feature")
    checkout = next(w for w in second["worktrees"] if w["branch"] == "feature")
    assert refreshed["head"] != feature["head"]
    assert refreshed["merged_into_target"] is False
    assert refreshed["target_comparison"] == {"ahead": 1, "behind": 0}
    assert [(p["path"], p["status"]) for p in checkout["changes"]] == [("local.txt", "??")]
    assert checkout["changes"][0]["modified_at"]
    assert checkout["current"] is True
    assert checkout["changes_omitted"] == 0


def test_protected_and_dependent_branches_are_preserved_even_when_merged(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    for name in ("release/1", "keep/topic", "retained", "parent", "child", "merged"):
        git(root, "branch", name)
    git(root, "config", "branch.retained.deleteMerged", "false")
    git(root, "config", "branch.keep/topic.deleteMerged", "false")
    git(root, "branch", "--set-upstream-to=parent", "child")
    facts = inventory(root)
    branches = {b["name"]: b for b in facts["branches"]}
    for name in ("main", "release/1", "keep/topic", "retained", "parent"):
        assert branches[name]["decision"] == "preserve"
        assert branches[name]["reasons"]
    assert branches["parent"]["dependents"] == ["child"]
    assert branches["merged"]["decision"] == "eligible"


def test_hook_injects_local_summary_and_a_direct_refresh_command(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    git(root, "branch", "merged")
    result = subprocess.run([sys.executable, str(HOOK), "--chatgpt"],
                            input=json.dumps({"prompt": "$cleanup-git", "cwd": str(root)}),
                            capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    context = output["hookSpecificOutput"]["additionalContext"]
    assert context.startswith("# Git cleanup inventory\n")
    assert "branches[2]{" in context
    command_line = next(line for line in context.splitlines() if line.startswith("inventory_command[2]: "))
    # Read only the primitive command cells, independently of the inventory renderer.
    cells = re.findall(r'"(?:\\.|[^"\\])*"|[^,]+', command_line.split(": ", 1)[1])
    refresh_command = [json.loads(cell) if cell.startswith('"') else cell for cell in cells]
    assert refresh_command == [sys.executable, str(SCRIPT)]
    cwd_line = next(line for line in context.splitlines() if line.startswith("inventory_cwd: "))
    cwd = cwd_line.removeprefix("inventory_cwd: ")
    cwd = json.loads(cwd) if cwd.startswith('"') else cwd
    assert cwd == str(root.resolve())
    refresh = subprocess.run(refresh_command, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    assert refresh.returncode == 0, refresh.stderr
    assert refresh.stdout.startswith("# Git cleanup inventory\n")
    assert f"target_oid: {git(root, 'rev-parse', 'main')}\n" in refresh.stdout


def test_merged_pr_does_not_authorize_deleting_later_local_commits(tmp_path, monkeypatch):
    gh_available(monkeypatch)
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "commit", "--allow-empty", "-m", "base")
    git(root, "switch", "-c", "feature")
    (root / "feature.txt").write_text("landed\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "feature")
    merged_head = git(root, "rev-parse", "HEAD")
    git(root, "switch", "main")
    git(root, "merge", "--squash", "feature")
    git(root, "commit", "-m", "squashed feature")
    git(root, "switch", "feature")
    git(root, "commit", "--allow-empty", "-m", "later work")
    git(root, "switch", "main")
    module = load_script()
    real_run = subprocess.run

    def github(args, **kwargs):
        if args[0] != "gh":
            return real_run(args, **kwargs)
        if args[1:3] == ["repo", "view"]:
            return subprocess.CompletedProcess(args, 0, "fixture/repo\n", "")
        query = parse_qs(urlsplit(args[-1]).query)
        if query.get("head") != ["fixture:feature"]:
            return subprocess.CompletedProcess(args, 0, "[[]]", "")
        pr = {"number": 10, "state": "closed", "merged_at": "2026-01-01T00:00:00Z",
              "head": {"ref": "feature", "sha": merged_head, "repo": {"full_name": "fixture/repo"}},
              "base": {"ref": "main", "repo": {"full_name": "fixture/repo"}}}
        fork = {**pr, "number": 11, "head": {"ref": "feature", "sha": merged_head, "repo": {"full_name": "fork/repo"}}}
        return subprocess.CompletedProcess(args, 0, json.dumps([[pr, fork]]), "")

    monkeypatch.setattr(subprocess, "run", github)
    facts = module.collect(root)
    branch = next(b for b in facts["branches"] if b["name"] == "feature")
    assert branch["merged_into_target"] is False
    assert branch["decision"] == "unresolved"
    assert branch["pr_status"] == "collected"
    assert [pr["number"] for pr in branch["pull_requests"]] == [10]
    assert branch["pull_requests"][0]["local_head_matches"] is False


def test_bare_repository_inventory_preserves_its_root_worktree(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    git(source, "init", "-b", "main")
    git(source, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    bare = tmp_path / "bare.git"
    git(source, "clone", "--bare", str(source), str(bare))
    linked = tmp_path / "linked"
    git(bare, "worktree", "add", "-b", "feature", str(linked))
    facts = inventory(bare)
    root = next(w for w in facts["worktrees"] if w["bare"])
    assert "bare" in root["removal_blockers"]
    assert [b["name"] for b in facts["branches"]] == ["feature", "main"]
    assert next(b for b in facts["branches"] if b["name"] == "feature")["decision"] == "preserve"


def test_inventory_detects_branch_changes_during_collection(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "commit", "--allow-empty", "-m", "base")
    git(root, "branch", "merged")
    git(root, "switch", "-c", "new")
    git(root, "commit", "--allow-empty", "-m", "new work")
    new_head = git(root, "rev-parse", "HEAD")
    git(root, "switch", "main")
    module = load_script()
    real_run = subprocess.run
    moved = False

    def concurrent_change(args, **kwargs):
        nonlocal moved
        if args[:2] == ["git", "merge-base"] and not moved:
            moved = True
            change = real_run(["git", "branch", "-f", "merged", new_head], cwd=root, capture_output=True)
            assert change.returncode == 0
        return real_run(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", concurrent_change)
    facts = module.collect(root)
    assert facts["snapshot_consistent"] is False
    merged = next(b for b in facts["branches"] if b["name"] == "merged")
    assert merged["decision"] == "unresolved"
    assert "snapshot-changed" in merged["reasons"]


def test_malformed_github_data_is_unknown_and_does_not_hide_local_inventory(tmp_path, monkeypatch):
    gh_available(monkeypatch)
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    git(root, "branch", "merged")
    module = load_script()
    real_run = subprocess.run

    def malformed_response(args, **kwargs):
        if args[0] != "gh":
            return real_run(args, **kwargs)
        response = "fixture/repo\n" if args[1:3] == ["repo", "view"] else '[{"message":"unexpected response"}]'
        return subprocess.CompletedProcess(args, 0, response, "")

    monkeypatch.setattr(subprocess, "run", malformed_response)
    facts = module.collect(root)
    assert facts["github_status"] == "unknown"
    branch = next(b for b in facts["branches"] if b["name"] == "merged")
    assert branch["pr_status"] == "unknown"
    assert branch["decision"] == "unresolved"
    assert branch["merged_into_target"] is True


def test_broken_worktree_cannot_borrow_its_parent_repository_clean_status(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    linked = root / "linked"
    git(root, "worktree", "add", "-b", "feature", str(linked))
    (linked / ".git").unlink()
    facts = inventory(root)
    checkout = next(w for w in facts["worktrees"] if w["branch"] == "feature")
    assert checkout["status_known"] is False
    assert checkout["clean"] is None
    assert "inspection-failed" in checkout["removal_blockers"]
    assert checkout["errors"]


@pytest.mark.parametrize("platform", ["claude", "chatgpt"])
def test_installed_hook_and_skill_script_run_and_uninstall_together(tmp_path, platform):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    tool = load_tool(HOOK.parent)
    target = Target.for_project(root, platform)
    installer = CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({tool.name})
    hook = target.destination_path("hooks", "cleanup_git_hook.py")
    script = target.destination_path("skills", "cleanup-git/cleanup_git.py")
    facts = subprocess.run([sys.executable, str(script)], cwd=root,
                           capture_output=True, text=True, encoding="utf-8")
    assert facts.returncode == 0, facts.stderr
    output = subprocess.run([sys.executable, str(hook), f"--{platform}"],
                            input=json.dumps({"prompt": "/cleanup-git", "cwd": str(root)}),
                            capture_output=True, text=True, encoding="utf-8")
    assert output.returncode == 0, output.stderr
    context = json.loads(output.stdout)["hookSpecificOutput"]["additionalContext"]
    target_line = f"target_oid: {git(root, 'rev-parse', 'main')}\n"
    assert target_line in context
    assert target_line in facts.stdout
    assert context.startswith("# Git cleanup inventory\n")
    assert facts.stdout.startswith("# Git cleanup inventory\n")
    installer.reconcile(set())
    assert not script.exists()
    assert not hook.exists()
    assert not target.destination_path("hooks", "cleanup_git.py").exists()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def test_large_untracked_inventories_stay_bounded_with_an_omitted_count(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "base")
    for index in range(80):
        (root / f"generated-{index}.txt").write_text("x\n")
    monkeypatch.syspath_prepend(str(HOOK.parent))
    spec = importlib.util.spec_from_file_location("cleanup_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real_run = module.subprocess.run
    monkeypatch.setattr(module.subprocess, "run", lambda args, **kwargs: real_run(args, **kwargs) if args[0] != "gh"
                        else subprocess.CompletedProcess(args, 1, "", "offline"))
    output = module.handle({"hook_event_name": "UserPromptSubmit", "prompt": "/cleanup-git", "cwd": str(root)})
    context = output["hookSpecificOutput"]["additionalContext"]
    assert "    changes[5]{path,status,modified_at}:" in context
    header = next(line for line in context.splitlines() if line.startswith("worktrees[1]{"))
    columns = header.split("{", 1)[1].removesuffix("}:").split(",")
    # Counts are numeric cells at the same positions as their table columns.
    row = context.split(header + "\n", 1)[1].splitlines()[0]
    cells = re.findall(r'"(?:\\.|[^"\\])*"|[^,]+', row.strip())
    assert cells[columns.index("changes_count")] == "80"
    assert cells[columns.index("changes_omitted")] == "75"


def test_hook_decodes_utf8_working_directory(tmp_path, monkeypatch, capsys):
    monkeypatch.syspath_prepend(str(HOOK.parent))
    spec = importlib.util.spec_from_file_location("cleanup_utf8_test", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    visited = []
    monkeypatch.setattr(hook, "prepared_inventory", lambda cwd: visited.append(cwd) or "inventory")
    cwd = tmp_path / "caf\u00e9-\u65e5\u672c\u8a9e-\U0001f600"
    payload = {"version": 1, "cwd": str(cwd), "hook_event_name": "UserPromptSubmit", "prompt": "/cleanup-git"}
    stream = io.TextIOWrapper(io.BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
                              encoding="cp1252", errors="surrogateescape")
    monkeypatch.setattr(sys, "stdin", stream)
    hook.main()
    result = json.loads(capsys.readouterr().out)
    assert visited == [cwd]
    assert result["hookSpecificOutput"]["additionalContext"] == "inventory"
