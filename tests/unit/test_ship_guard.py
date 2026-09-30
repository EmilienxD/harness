"""Loop policy through provider PreToolUse payloads."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "harness/building/ship/ship_hook.py"


@pytest.fixture
def checkout(tmp_path):
    root = tmp_path / "main"
    root.mkdir()
    for args in [("init",), ("config", "user.name", "Test"), ("config", "user.email", "test@example.invalid"), ("commit", "--allow-empty", "-m", "initial")]:
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
    worktree = tmp_path / "work"
    subprocess.run(["git", "-C", str(root), "worktree", "add", "-b", "feature", str(worktree)], check=True, capture_output=True)
    return root, worktree


def decision(checkout, tool, data, loop=True):
    root, worktree = checkout
    payload = {"cwd": str(worktree), "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": data}
    result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload), capture_output=True, text=True,
                            env={**os.environ, "HARNESS_EXECUTION_MODE": "loop" if loop else ""})
    assert (result.returncode, result.stderr) == (0, "")
    return json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"] if result.stdout.strip() else "allow"


@pytest.mark.parametrize("command,expected", [
    ("git status --short", "allow"), ("git diff HEAD -- src", "allow"), ("git log -5", "allow"),
    ("git branch --show-current", "allow"), ("git worktree list --porcelain", "allow"),
    ("git add src/app.py", "deny"), ("git -C . commit -m done", "deny"), ("git push", "deny"),
    ("git switch main", "deny"), ("git checkout -- src/app.py", "deny"), ("git branch new", "deny"),
    ("git fetch", "deny"), ("git config user.name Bob", "deny"), ("git diff --output=patch.txt", "deny"),
    ("git -c alias.sneak=push sneak", "deny"), ("git status && git reset --hard", "deny"),
    ('bash -c "git push"', "deny"), ('powershell -Command "gh pr merge 3"', "deny"),
    ("gh issue view 3 --comments", "allow"), ("gh pr list", "allow"),
    ("gh api repos/owner/repo/issues", "allow"), ("gh api graphql -f query='{ viewer { login } }'", "allow"),
    ("gh issue edit 3 --add-label done", "deny"), ("gh pr merge 3", "deny"),
    ("gh api repos/owner/repo/issues -f title=oops", "deny"),
    ("gh api repos/owner/repo/issues -ftitle=oops", "deny"),
    ("gh api repos/owner/repo/issues -Ftitle=oops", "deny"),
    ("gh api repos/owner/repo/issues --raw-field=title=oops", "deny"),
    ("gh api repos/owner/repo/issues -X GET -ftitle=filter", "allow"),
    ("gh api graphql -f query='mutation { deleteIssue(input: {}) { clientMutationId } }'", "deny"),
    ("gh api graphql -fquery='{ viewer { login } }'", "allow"),
    ("gh api graphql --raw-field='query=query Viewer { viewer { login } }'", "allow"),
    ("gh api graphql -f query=@query.graphql", "deny"),
    ("gh api graphql -Fquery=@query.graphql", "deny"),
    ('gh api graphql -f "query=$QUERY"', "deny"),
    ('gh api graphql -f "query={ viewer { login } } $EXTRA"', "deny"),
    ("python -m pytest", "allow"),
])
def test_git_and_github_are_read_only_in_loop(checkout, command, expected):
    assert decision(checkout, "Bash", {"command": command}) == expected


@pytest.mark.parametrize("tool", ["Write", "Edit", "apply_patch", "Bash", "PowerShell"])
def test_other_checkout_and_workflows_protected_but_external_paths_writable(checkout, tool):
    root, worktree = checkout
    for path, expected in [(root / "app.py", "deny"), (worktree / "tests/workflow/new.md", "deny"), (worktree / "src/app.py", "allow"), (root.parent / "evidence.txt", "allow")]:
        if tool == "apply_patch":
            data = {"patch": f"*** Begin Patch\n*** Add File: {path}\n+data\n*** End Patch"}
        elif tool == "Bash":
            data = {"command": f'echo data > "{path}"'}
        elif tool == "PowerShell":
            data = {"command": f'Set-Content -LiteralPath "{path}" -Value data'}
        else:
            data = {"file_path": str(path)}
        assert decision(checkout, tool, data) == expected
        assert decision(checkout, tool, data, loop=False) == "allow"


def test_custom_workflow_and_parent_directory_mutations_are_protected(checkout):
    root, worktree = checkout
    folder = worktree / "acceptance"
    folder.mkdir()
    (folder / "flow.md").write_text('---\ncovers: ["src/**"]\nverified_hash: null\n---\n', encoding="utf-8")
    assert decision(checkout, "Write", {"file_path": str(folder / "flow.md")}) == "deny"
    assert decision(checkout, "Bash", {"command": 'rm -rf tests'}) == "deny"
    assert decision(checkout, "Bash", {"command": f'cat "{root / "app.py"}"'}) == "allow"


def test_embedded_relative_workflow_writes_and_renames_are_denied(checkout):
    assert decision(checkout, "Bash", {"command": '''python -c "from pathlib import Path; Path('tests/workflow/app.md').write_text('x')"'''}) == "deny"
    assert decision(checkout, "apply_patch", {"patch": "*** Begin Patch\n*** Update File: app.md\n*** Move to: tests/workflow/app.md\n*** End Patch"}) == "deny"
