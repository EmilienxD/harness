"""Workflow confirmation and provider hooks through their installed CLI seam."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "harness/building/test-workflows/test_workflows.py"


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def project(tmp_path):
    git(tmp_path, "init")
    git(tmp_path, "config", "user.email", "test@example.invalid")
    git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.py").write_bytes(b"print('ok')\n")
    workflow = tmp_path / "tests/workflow/app.md"
    workflow.parent.mkdir(parents=True)
    workflow.write_text('---\ncovers: ["src/**/*.py"]\nverified_hash: null\n---\n\n## Preconditions\n- Ready.\n## Steps\n- Request a greeting.\n## Acceptance Criteria\n- [ ] The greeting is displayed.\n## Potential Problems\n- A missing greeting.\n', encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial")
    return tmp_path


def cli(project, *args, env=None, payload=None):
    result = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=project,
                            env={**os.environ, "HARNESS_STATE_DIR": str(project.parent / "state"), "HARNESS_EXECUTION_MODE": "", **(env or {})},
                            input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, text=True)
    assert result.stderr == "", result.stderr
    return result.returncode, json.loads(result.stdout) if result.stdout.strip() else None


def test_confirm_and_status_track_changed_files_and_normalize_line_endings(project):
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["state"] == "stale"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    assert cli(project, "status")[0] == 0
    (project / "src/app.py").write_bytes(b"print('ok')\r\n")
    assert cli(project, "status")[0] == 0
    (project / "src/app.py").write_bytes(b"print('changed')\n")
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["changed_files"] == ["src/app.py"]


def test_broken_mapping_custom_location_and_deleted_files(project):
    custom = project / "acceptance"
    custom.mkdir()
    (project / "tests/workflow/app.md").rename(custom / "app.md")
    assert cli(project, "confirm", "acceptance/app.md")[0] == 0
    (project / "src/app.py").unlink()
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["workflow"] == "acceptance/app.md"
    assert status["workflows"][0]["state"] == "broken"
    assert status["workflows"][0]["changed_files"] == ["src/app.py"]
    assert cli(project, "confirm", "acceptance/app.md")[0] == 2


def event(project, name, **extra):
    return {"cwd": str(project), "session_id": "session", "hook_event_name": name, **extra}


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("loop", [False, True])
def test_edit_notice_once_and_stop_defers_to_runtime_in_loop(project, provider, loop):
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    env = {"HARNESS_EXECUTION_MODE": "loop" if loop else ""}
    args = ("hook", "--provider", provider)
    assert cli(project, *args, env=env, payload=event(project, "SessionStart")) == (0, None)
    (project / "src/app.py").write_text("changed", encoding="utf-8")
    edit = event(project, "PostToolUse", tool_name="Edit", tool_input={"file_path": "src/app.py"})
    code, output = cli(project, *args, env=env, payload=edit)
    assert code == 0
    # Codex's PostToolUse and Stop output wires deny unknown fields.
    assert set(output) <= {"continue", "decision", "hookSpecificOutput", "reason", "stopReason", "suppressOutput", "systemMessage"}
    assert output["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    assert "tests/workflow/app.md" in output["hookSpecificOutput"]["additionalContext"]
    assert cli(project, *args, env=env, payload=edit) == (0, None)
    code, output = cli(project, *args, env=env, payload=event(project, "Stop"))
    assert code == 0
    if loop:
        assert output is None
    else:
        assert set(output) <= {"continue", "decision", "reason", "stopReason", "suppressOutput", "systemMessage"}
        assert output["decision"] == "block"
    assert cli(project, *args, env=env, payload=event(project, "Stop")) == (0, None)


def test_stop_detects_bash_changes_but_ignores_existing_dirty_files(project):
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    (project / "src/app.py").write_text("preexisting", encoding="utf-8")
    args = ("hook", "--provider", "chatgpt")
    assert cli(project, *args, payload=event(project, "SessionStart")) == (0, None)
    assert cli(project, *args, payload=event(project, "Stop")) == (0, None)
    subprocess.run([sys.executable, "-c", "from pathlib import Path; Path('src/app.py').write_text('shell changed')"], cwd=project, check=True)
    code, output = cli(project, *args, payload=event(project, "Stop"))
    assert code == 0
    assert output["decision"] == "block"


def test_loop_cli_cannot_stamp_workflows(project):
    assert cli(project, "confirm", "tests/workflow/app.md", env={"HARNESS_EXECUTION_MODE": "loop"})[0] == 2


def test_unconfirmed_workflow_detects_deleted_last_covered_file(project):
    args = ("hook", "--provider", "chatgpt")
    cli(project, *args, payload=event(project, "SessionStart"))
    (project / "src/app.py").unlink()
    code, output = cli(project, *args, payload=event(project, "Stop"))
    assert code == 0
    assert output["decision"] == "block"


def test_status_detects_invalid_format_instead_of_crashing(project):
    path = project / "tests/workflow/app.md"
    path.write_text(path.read_text().replace("verified_hash: null", 'verified_hash: null\nverified_files: "bad"'), encoding="utf-8")
    code, output = cli(project, "status")
    assert code == 1
    assert output["workflows"][0]["state"] == "invalid"


@pytest.mark.parametrize("section", ["Preconditions", "Steps", "Acceptance Criteria", "Potential Problems"])
def test_missing_required_section_cannot_be_confirmed(project, section):
    path = project / "tests/workflow/app.md"
    path.write_text(path.read_text().replace(f"## {section}\n", ""), encoding="utf-8")
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["state"] == "invalid"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 2


def test_confirmation_preserves_acceptance_criteria_and_problems(project):
    path = project / "tests/workflow/app.md"
    body = path.read_text().split("\n---\n", 1)[1]
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    assert path.read_text().split("\n---\n", 1)[1] == body


def test_reading_a_covered_file_does_not_emit_an_edit_notice(project):
    args = ("hook", "--provider", "chatgpt")
    cli(project, *args, payload=event(project, "SessionStart"))
    assert cli(project, *args, payload=event(project, "PostToolUse", tool_name="Read", tool_input={"file_path": "src/app.py"})) == (0, None)
