"""Public-boundary tests for the three rules-driven path guards."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
HOOK_PATHS = {
    "on-edit-block": ROOT
    / "harness/guards/on-edit-block/on_edit_block_hook.py",
    "on-edit-reminder": ROOT
    / "harness/guards/on-edit-reminder/on_edit_reminder_hook.py",
    "on-read-reminder": ROOT
    / "harness/guards/on-read-reminder/on_read_reminder_hook.py",
}
EDIT_GUARDS = ("on-edit-block", "on-edit-reminder")


def run_hook(name: str, payload: object, project: Path, provider: str = "claude") -> tuple[int, dict | None, str]:
    project.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [sys.executable, str(HOOK_PATHS[name]), f"--{provider}"],
        cwd=project,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=dict(
            os.environ,
            CLAUDE_PROJECT_DIR=str(project),
            TEMP=str(project),
            TMP=str(project),
        ),
    )
    stdout = result.stdout.strip()
    return result.returncode, json.loads(stdout) if stdout else None, result.stderr


def configure(project: Path, name: str, rules: str, files: dict[str, str] | None = None) -> None:
    guards_dir = project / ".harness" / "guards"
    guards_dir.mkdir(parents=True, exist_ok=True)
    (guards_dir / f"{name}.toml").write_text(rules, encoding="utf-8")
    for relative, content in (files or {}).items():
        destination = project / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def path_event(name: str, path: str, **extra: object) -> dict:
    event = {
        "hook_event_name": "PreToolUse" if name == "on-edit-block" else "PostToolUse",
        "tool_name": "Read" if name == "on-read-reminder" else "Write",
        "tool_input": {"file_path": path},
    }
    event.update(extra)
    return event


@pytest.mark.parametrize("name", HOOK_PATHS)
@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("explicit_workdir", [False, True])
def test_codex_session_policy_matches_tool_relative_targets(name, native, explicit_workdir, tmp_path):
    configure(tmp_path, name,
              'version=1\n[[rules]]\npatterns=["child/src/**"]\nrequire=["GUIDE.md"]\n',
              {"GUIDE.md": "guidance\n", "child/src/target.py": "value = 1\n"})
    event = path_event(name, "src/target.py", cwd=str(tmp_path / "child"))
    if native:
        if name != "on-read-reminder":
            event.update(tool_name="apply_patch", tool_input={"command": "*** Update File: src/target.py\n@@\n-value = 1\n+value = 2"})
    else:
        command = "cat src/target.py" if name == "on-read-reminder" else "printf x > src/target.py"
        event.update(tool_name="Bash", tool_input={"command": command})
    if explicit_workdir:
        event["cwd"] = str(tmp_path)
        event["tool_input"]["workdir"] = "child"
    event["tool_response"] = {"exit_code": 0}

    code, output, stderr = run_hook(name, event, tmp_path, "chatgpt")

    assert (code, stderr) == (0, "")
    assert output is not None
    assert output["hookSpecificOutput"]["hookEventName"] == event["hook_event_name"]
    if name == "on-edit-block":
        assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize("name", HOOK_PATHS)
def test_codex_path_guards_do_not_search_above_session_directory(name, tmp_path):
    configure(tmp_path, name, 'version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["GUIDE.md"]\n',
              {"GUIDE.md": "ancestor guidance\n", "child/target.py": "x\n"})
    child = tmp_path / "child"
    event = path_event(name, "target.py", cwd=str(child), tool_response={"exit_code": 0})
    assert run_hook(name, event, child, "chatgpt") == (0, None, "")


@pytest.mark.parametrize("name", EDIT_GUARDS)
def test_codex_child_read_evidence_satisfies_session_requirements(name, tmp_path):
    configure(tmp_path, name, 'version=1\n[[rules]]\npatterns=["child/src/**"]\nrequire=["child/GUIDE.md"]\n',
              {"child/GUIDE.md": "guidance\n", "child/src/target.py": "x\n"})
    common_fields = {"session_id": "child-read", "cwd": str(tmp_path / "child")}
    read = dict(common_fields, hook_event_name="PostToolUse", tool_name="Bash",
                tool_input={"command": "cat GUIDE.md"}, tool_response={"stdout": "guidance\n", "exit_code": 0})
    assert run_hook(name, read, tmp_path, "chatgpt") == (0, None, "")
    edit = path_event(name, "src/target.py", **common_fields, tool_response={"exit_code": 0})
    assert run_hook(name, edit, tmp_path, "chatgpt") == (0, None, "")


@pytest.mark.parametrize("name", HOOK_PATHS)
@pytest.mark.parametrize("payload", [None, [], "event", 42])
def test_non_object_json_input_is_ignored(name, payload, tmp_path):
    assert run_hook(name, payload, tmp_path) == (0, None, "")


@pytest.mark.parametrize("name", HOOK_PATHS)
@pytest.mark.parametrize(
    ("rules", "path", "matches"),
    [
        ('version=1\n[[rules]]\npatterns=["service/**/models/*.py"]\nrequire=["docs/guide.md"]\n', "service/models/user.py", True),
        ('version=1\n[[rules]]\npatterns=["service/**/models/*.py"]\nrequire=["docs/guide.md"]\n', "service/api/models/user.py", True),
        ('version=1\n[[rules]]\npatterns=["service/**/models/*.py"]\nrequire=["docs/guide.md"]\n', "other/service/models/user.py", False),
        ('version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["docs/guide.md"]\n', "deeply/nested/user.py", True),
        ('version=1\n[[rules]]\npatterns=["docs/"]\nrequire=["docs/guide.md"]\n', "docs/reference/api.md", True),
        ('version=1\n[[rules]]\npatterns=["config?.toml"]\nrequire=["docs/guide.md"]\n', "config12.toml", False),
        (
            'version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["docs/guide.md"]\n[[rules]]\npatterns=["legacy/**"]\nexclude=true\n[[rules]]\npatterns=["legacy/special.py"]\nrequire=["docs/guide.md"]\n',
            "legacy/special.py",
            True,
        ),
        ('version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["docs/guide.md"]\n[[rules]]\npatterns=["legacy/**"]\nexclude=true\n', "legacy/old.py", False),
    ],
)
def test_shared_rules_language_has_the_same_observable_matches(
    name, rules, path, matches, tmp_path
):
    configure(tmp_path, name, rules, {"docs/guide.md": "Follow the guide.\n"})

    code, output, stderr = run_hook(name, path_event(name, path), tmp_path)

    assert (code, stderr) == (0, "")
    assert (output is not None) is matches


@pytest.mark.parametrize("name", HOOK_PATHS)
def test_rule_order_can_clear_and_then_add_requirements_again(name, tmp_path):
    configure(
        tmp_path,
        name,
        (
            'version=1\n[[rules]]\npatterns=["*.py"]\nrequire=["docs/base.md", "docs/shared.md"]\n'
            '[[rules]]\npatterns=["legacy/**"]\nexclude=true\n'
            '[[rules]]\npatterns=["legacy/special.py"]\nrequire=["docs/special.md"]\n'
        ),
        {
            "docs/base.md": "base\n",
            "docs/shared.md": "shared\n",
            "docs/special.md": "special\n",
        },
    )

    code, output, stderr = run_hook(
        name, path_event(name, "legacy/special.py"), tmp_path
    )

    assert (code, stderr) == (0, "")
    assert output is not None


@pytest.mark.parametrize("name", HOOK_PATHS)
def test_invalid_toml_is_reported_instead_of_crashing(name, tmp_path):
    configure(tmp_path, name, "version = [\n")

    code, output, stderr = run_hook(name, path_event(name, "src/app.py"), tmp_path)

    assert (code, stderr) == (0, "")
    assert output is not None


@pytest.mark.parametrize("name", EDIT_GUARDS)
@pytest.mark.parametrize(
    "tool_use",
    [
        {
            "type": "tool_use",
            "name": "Read",
            "input": {"filePath": "docs/team guide.md"},
        },
        {
            "type": "tool_use",
            "name": "Bash",
            "input": {"command": 'cat "docs/team guide.md"'},
        },
    ],
)
def test_edit_guards_require_results_rather_than_transcript_read_attempts(
    name, tool_use, tmp_path
):
    configure(
        tmp_path,
        name,
        'version=1\n[[rules]]\npatterns=["src/**"]\nrequire=["docs/team guide.md"]\n',
        {"docs/team guide.md": "Team rules.\n"},
    )
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        "not json\n" + json.dumps({"message": {"content": [tool_use]}}) + "\n",
        encoding="utf-8",
    )

    result = run_hook(
        name,
        path_event(name, "src/app.py", transcript_path=str(transcript)),
        tmp_path,
    )

    assert result[0] == 0
    assert result[1] is not None
    assert result[2] == ""


@pytest.mark.parametrize("name", EDIT_GUARDS)
def test_edit_guards_do_not_treat_an_arbitrary_command_as_a_read(name, tmp_path):
    configure(
        tmp_path,
        name,
        'version=1\n[[rules]]\npatterns=["src/**"]\nrequire=["docs/guide.md"]\n',
        {"docs/guide.md": "Team rules.\n"},
    )
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "type": "tool_use",
                "name": "Bash",
                "input": {"command": "python docs/guide.md"},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    code, output, stderr = run_hook(
        name,
        path_event(name, "src/app.py", transcript_path=str(transcript)),
        tmp_path,
    )

    assert (code, stderr) == (0, "")
    assert output is not None


def test_on_edit_block_denies_once_with_the_guide_then_allows_retry(tmp_path):
    name = "on-edit-block"
    configure(
        tmp_path,
        name,
        'version=1\n[[rules]]\npatterns=["src/**"]\nrequire=["docs/guide.md"]\n',
        {"docs/guide.md": "Use the domain vocabulary.\n"},
    )
    event = path_event(name, "src/app.py", session_id="block-once")

    code, first, stderr = run_hook(name, event, tmp_path)
    second = run_hook(name, event, tmp_path)

    assert (code, stderr) == (0, "")
    assert first["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert second == (0, None, "")


def test_on_edit_reminder_throttles_an_unread_guide_within_a_burst(tmp_path):
    name = "on-edit-reminder"
    configure(
        tmp_path,
        name,
        'version=1\n[[rules]]\npatterns=["src/**"]\nrequire=["docs/guide.md"]\n',
        {"docs/guide.md": "Use the domain vocabulary.\n"},
    )
    event = path_event(name, "src/app.py", session_id="remind-once")

    first = run_hook(name, event, tmp_path)
    second = run_hook(name, event, tmp_path)

    assert first[0] == 0
    assert first[1] is not None
    assert second == (0, None, "")


@pytest.mark.parametrize("name", HOOK_PATHS)
def test_missing_required_files_are_reported_without_blocking(name, tmp_path):
    configure(tmp_path, name, 'version=1\n[[rules]]\npatterns=["src/**"]\nrequire=["docs/missing.md"]\n')

    code, output, stderr = run_hook(name, path_event(name, "src/app.py"), tmp_path)

    assert (code, stderr) == (0, "")
    assert output is not None
    if name == "on-edit-block":
        assert "permissionDecision" not in output["hookSpecificOutput"]


def test_on_read_reminder_collects_paths_from_one_shell_read(tmp_path):
    name = "on-read-reminder"
    configure(
        tmp_path,
        name,
        'version=1\n[[rules]]\npatterns=["src/*.py"]\nrequire=["docs/source.md"]\n[[rules]]\npatterns=["tests/*.py"]\nrequire=["docs/tests.md"]\n',
        {"docs/source.md": "source\n", "docs/tests.md": "tests\n"},
    )
    event = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": "cat src/app.py tests/test_app.py"},
    }

    code, output, stderr = run_hook(name, event, tmp_path)

    assert (code, stderr) == (0, "")
    assert output is not None
