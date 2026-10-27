"""Shared shell coverage and provider adapters through their public hook inputs."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("path_guard_common", ROOT / "harness/internal/path-guard-common/path_guard_common.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


@pytest.mark.parametrize("command,paths", [
    ('printf "after" > "src/team file.py"', ["src/team file.py"]),
    ('echo after >> src/a.py', ["src/a.py"]),
    ('echo after | tee src/a.py src/b.py', ["src/a.py", "src/b.py"]),
    ("sed -i 's/a/b/' src/a.py", ["src/a.py"]),
    ("perl -pi -e 's/a/b/' src/a.py", ["src/a.py"]),
    ('Set-Content -LiteralPath "src/team file.py" -Value after', ["src/team file.py"]),
    ('echo after | Out-File -FilePath src/a.py', ["src/a.py"]),
    ('cd src && echo after > a.py', ["src/a.py"]),
    ('cp source.py src/a.py', ["src/a.py"]),
    ('mv src/a.py src/b.py', ["src/a.py", "src/b.py"]),
    ('cat src/a.py', []),
    ('echo "cat src/a.py"', []),
])
def test_shell_mutation_paths(command, paths, tmp_path):
    assert common.shell_paths(command, tmp_path, writing=True) == paths


@pytest.mark.parametrize("command,paths", [
    ('cat "docs/team guide.md"', ["docs/team guide.md"]),
    ('Get-Content -TotalCount 1 docs/guide.md', ["docs/guide.md"]),
    ('echo "cat docs/guide.md"', []),
    ('python docs/guide.md', []),
])
def test_shell_read_paths(command, paths, tmp_path):
    assert common.shell_paths(command, tmp_path) == paths


def test_exec_working_directory_and_nested_shell_paths(tmp_path):
    assert common.edit_paths("Bash", {"command": "echo after > ../target.py", "workdir": "src"}, tmp_path) == ["target.py"]
    assert common.read_paths("Bash", {"command": "cat ../guide.md", "workdir": "src"}, tmp_path) == ["guide.md"]
    assert common.shell_paths("cd src && bash -c 'echo after > nested.py'", tmp_path, writing=True) == ["src/nested.py"]
    (tmp_path / "src").mkdir()
    assert common.shell_paths("cp target.py src", tmp_path, writing=True) == ["src/target.py"]


def invoke(project, name, provider, event):
    hook = ROOT / "harness/guards" / name / (name.replace("-", "_") + "_hook.py")
    result = subprocess.run([sys.executable, str(hook), "--" + provider], input=json.dumps(event),
                            text=True, capture_output=True, cwd=project,
                            env={**os.environ, "TEMP": str(project), "TMP": str(project)})
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else None


def setup(project, name):
    policy = project / ".harness/guards" / (name + ".toml")
    policy.parent.mkdir(parents=True, exist_ok=True)
    policy.write_text('version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["guide.md"]\n')
    (project / "guide.md").write_text("conventions\n" * 1200)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("read", ["failed", "partial", "full", "native", "changed"])
def test_only_successful_complete_reads_authorize_shell_edits(provider, read, tmp_path):
    setup(tmp_path, "on-edit-block")
    content = (tmp_path / "guide.md").read_text()
    event = {"session_id": "read-check", "cwd": str(tmp_path), "hook_event_name": "PostToolUse",
             "tool_name": "Bash", "tool_input": {"command": "cat guide.md"},
             "tool_response": {"stdout": content, "exit_code": 0}}
    if read == "failed":
        event["tool_response"]["exit_code"] = 1
    elif read == "partial":
        event["tool_input"]["command"] = "head -n 1 guide.md"
        event["tool_response"]["stdout"] = "conventions\n"
    elif read == "native":
        event.update(tool_name="Read", tool_input={"file_path": "guide.md"},
                     tool_response={"file": {"content": content, "startLine": 1, "numLines": 1200}})
    invoke(tmp_path, "on-edit-block", provider, event)
    if read == "changed":
        (tmp_path / "guide.md").write_text(content + "new convention\n")
    output = invoke(tmp_path, "on-edit-block", provider, {**event, "hook_event_name": "PreToolUse",
        "tool_name": "Bash", "tool_input": {"command": "echo after > target.py"}})
    assert (output is None) == (read in {"full", "native"})


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_large_denial_does_not_authorize_retry(provider, tmp_path):
    setup(tmp_path, "on-edit-block")
    event = {"session_id": "large-guide", "hook_event_name": "PreToolUse", "cwd": str(tmp_path),
             "tool_name": "Bash", "tool_input": {"command": "echo after > target.py"}}
    for _ in range(2):
        assert invoke(tmp_path, "on-edit-block", provider, event)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_chatgpt_patch_checks_every_affected_path(tmp_path):
    setup(tmp_path, "on-edit-block")
    output = invoke(tmp_path, "on-edit-block", "chatgpt", {"hook_event_name": "PreToolUse", "cwd": str(tmp_path),
        "tool_name": "apply_patch", "tool_input": {"command": "*** Begin Patch\n*** Add File: safe.txt\n+ok\n*** Update File: target.py\n@@\n-a\n+b\n*** Move to: moved.py\n*** End Patch"}})
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_native_read_ranges_accumulate_and_stay_session_local(provider, tmp_path):
    setup(tmp_path, "on-edit-block")
    lines = (tmp_path / "guide.md").read_text().splitlines()
    event = {"session_id": "ranges", "cwd": str(tmp_path), "hook_event_name": "PostToolUse", "tool_name": "Read",
             "tool_input": {"file_path": "guide.md"}}
    write = {**event, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "echo after > target.py"}}
    for start, end in [(0, 1), (1, len(lines))]:
        invoke(tmp_path, "on-edit-block", provider, {**event, "tool_response": {
            "file": {"content": "\n".join(lines[start:end]), "startLine": start + 1, "numLines": end - start}}})
        assert (invoke(tmp_path, "on-edit-block", provider, write) is None) == (end == len(lines))
    assert invoke(tmp_path, "on-edit-block", provider, {**write, "session_id": "other"}) is not None
    other_provider = "chatgpt" if provider == "claude" else "claude"
    assert invoke(tmp_path, "on-edit-block", other_provider, write) is not None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_shell_reminder_skips_failures_and_preserves_cooldown(provider, tmp_path):
    setup(tmp_path, "on-edit-reminder")
    event = {"session_id": "reminders", "cwd": str(tmp_path), "hook_event_name": "PostToolUse", "tool_name": "Bash",
             "tool_input": {"command": "echo after > target.py"}, "tool_response": {"exit_code": 1}}
    assert invoke(tmp_path, "on-edit-reminder", provider, event) is None
    event["tool_response"] = "Process exited with code 1\nOutput:\nfailed"
    assert invoke(tmp_path, "on-edit-reminder", provider, event) is None
    event["tool_response"] = {"exit_code": 0}
    assert invoke(tmp_path, "on-edit-reminder", provider, event) is not None
    assert invoke(tmp_path, "on-edit-reminder", provider, event) is None
