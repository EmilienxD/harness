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


def run_hook(name: str, payload: object, project: Path) -> tuple[int, dict | None, str]:
    project.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [sys.executable, str(HOOK_PATHS[name])],
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
    claude_dir = project / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / f"{name}.rules").write_text(rules, encoding="utf-8")
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
@pytest.mark.parametrize("payload", [None, [], "event", 42])
def test_non_object_json_input_is_ignored(name, payload, tmp_path):
    assert run_hook(name, payload, tmp_path) == (0, None, "")


@pytest.mark.parametrize("name", HOOK_PATHS)
@pytest.mark.parametrize(
    ("rules", "path", "matches"),
    [
        ("service/**/models/*.py -> docs/guide.md\n", "service/models/user.py", True),
        ("service/**/models/*.py -> docs/guide.md\n", "service/api/models/user.py", True),
        ("service/**/models/*.py -> docs/guide.md\n", "other/service/models/user.py", False),
        ("*.py -> docs/guide.md\n", "deeply/nested/user.py", True),
        ("docs/ -> docs/guide.md\n", "docs/reference/api.md", True),
        ("config?.toml -> docs/guide.md\n", "config12.toml", False),
        (
            "*.py -> docs/guide.md\n!legacy/**\nlegacy/special.py -> docs/guide.md\n",
            "legacy/special.py",
            True,
        ),
        ("*.py -> docs/guide.md\n!legacy/**\n", "legacy/old.py", False),
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
            "*.py -> docs/base.md, docs\\shared.md\n"
            "!legacy/**\n"
            "legacy/special.py -> docs/special.md\n"
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
def test_invalid_rules_report_bounded_line_numbers_instead_of_crashing(name, tmp_path):
    configure(tmp_path, name, "invalid\n" * 5)

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
def test_edit_guards_recognize_prior_reads_in_nested_transcript_entries(
    name, tool_use, tmp_path
):
    configure(
        tmp_path,
        name,
        "src/** -> docs/team guide.md\n",
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

    assert result == (0, None, "")


@pytest.mark.parametrize("name", EDIT_GUARDS)
def test_edit_guards_do_not_treat_an_arbitrary_command_as_a_read(name, tmp_path):
    configure(
        tmp_path,
        name,
        "src/** -> docs/guide.md\n",
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
        "src/** -> docs/guide.md\n",
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
        "src/** -> docs/guide.md\n",
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
    configure(tmp_path, name, "src/** -> docs/missing.md\n")

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
        "src/*.py -> docs/source.md\ntests/*.py -> docs/tests.md\n",
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
