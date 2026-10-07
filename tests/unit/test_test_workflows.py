"""Workflow status and confirmation through their installed CLI seam."""
import json
import os
import runpy
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
    workflow.write_text('---\ncovers: ["src/**/*.py"]\n---\n\n## Preconditions\n- Ready.\n## Steps\n- Request a greeting.\n## Acceptance Criteria\n- [ ] The greeting is displayed.\n## Potential Problems\n- A missing greeting.\n', encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial")
    return tmp_path


def cli(project, *args, env=None, json_output=True):
    result = subprocess.run([sys.executable, str(SCRIPT), *(["--json"] if json_output else []), *args], cwd=project,
                            env={**os.environ, "HARNESS_EXECUTION_MODE": "", **(env or {})},
                            capture_output=True, text=True, encoding="utf-8")
    assert result.stderr == "", result.stderr
    if not json_output:
        return result.returncode, result.stdout
    return result.returncode, json.loads(result.stdout) if result.stdout.strip() else None


def test_default_toon_status_and_confirmation_preserve_output_fields(project):
    code, output = cli(project, "status", json_output=False)
    record = cli(project, "status")[1]["workflows"][0]
    assert code == 1
    assert output == (
        "workflows[1]:\n"
        "  - workflow: tests/workflow/app.md\n"
        "    state: stale\n"
        f"    current_hash: {record['current_hash']}\n"
        "    files:\n"
        f"      \"src/app.py\": {record['files']['src/app.py']}\n"
        "    covers[1]: src/**/*.py\n"
        "    changed_files[1]: src/app.py\n"
    )
    code, output = cli(project, "confirm", "tests/workflow/app.md", json_output=False)
    assert code == 0
    assert output == (
        "workflow: tests/workflow/app.md\n"
        "state: passed\n"
        f"current_hash: {record['current_hash']}\n"
        "files:\n"
        f"  \"src/app.py\": {record['files']['src/app.py']}\n"
        "covers[1]: src/**/*.py\n"
        "changed_files: []\n"
    )
    assert cli(project, "status", json_output=False)[0] == 0
    assert json.loads(cli(project, "status", "--json", json_output=False)[1]) == cli(project, "status")[1]
    assert json.loads(cli(project, "confirm", "tests/workflow/app.md", "--json", json_output=False)[1])["state"] == "passed"


def test_empty_discovery_and_command_errors_use_selected_format(project):
    (project / "tests/workflow/app.md").unlink()
    assert cli(project, "status", json_output=False) == (0, "workflows: []\n")
    for json_output in (True, False):
        code, output = cli(project, "confirm", "missing.md", json_output=json_output)
        assert code == 2
        if json_output:
            assert "missing.md" in output["error"]
        else:
            assert output.startswith('error: "')
            assert "missing.md" in output


def test_toon_quotes_ambiguous_values_and_preserves_unicode_and_controls():
    render = runpy.run_path(str(SCRIPT))["render_toon"]
    assert render({"changed_files": ["caf\u00e9.txt", "a,b.txt", "true", "05", "-file", "#file", "a[b]", 'a"b',
                                    "a\\b\n\t\r\b\f", ""], "a:b": "false"}) == (
        'changed_files[10]: caf\u00e9.txt,"a,b.txt","true","05","-file","#file","a[b]","a\\"b",'
        '"a\\\\b\\n\\t\\r\\u0008\\u000c",""\n"a:b": "false"'
    )


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


def test_loop_cli_cannot_stamp_workflows(project):
    assert cli(project, "confirm", "tests/workflow/app.md", env={"HARNESS_EXECUTION_MODE": "loop"})[0] == 2


def test_status_detects_invalid_format_instead_of_crashing(project):
    path = project / "tests/workflow/app.manifest.json"
    path.write_text(json.dumps({"verified_files": "bad"}), encoding="utf-8")
    code, output = cli(project, "status")
    assert code == 1
    assert output["workflows"][0]["state"] == "invalid"


@pytest.mark.parametrize("section", ["Steps", "Acceptance Criteria"])
def test_missing_required_section_cannot_be_confirmed(project, section):
    path = project / "tests/workflow/app.md"
    path.write_text(path.read_text().replace(f"## {section}\n", ""), encoding="utf-8")
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["state"] == "invalid"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 2


@pytest.mark.parametrize("include_problems", [True, False])
@pytest.mark.parametrize("include_preconditions", [True, False])
def test_confirmation_preserves_workflow_with_optional_sections(project, include_problems, include_preconditions):
    path = project / "tests/workflow/app.md"
    if not include_preconditions:
        path.write_text(path.read_text().replace("## Preconditions\n- Ready.\n", ""), encoding="utf-8")
    if not include_problems:
        path.write_text(path.read_text().split("## Potential Problems\n")[0], encoding="utf-8")
    body = path.read_bytes()
    assert not path.with_suffix(".manifest.json").exists()
    assert cli(project, "status")[1]["workflows"][0]["state"] == "stale"
    assert not path.with_suffix(".manifest.json").exists()
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    assert path.read_bytes() == body
    manifest = json.loads(path.with_suffix(".manifest.json").read_text())
    assert set(manifest) == {"verified_hash", "verified_files"}
    assert manifest["verified_files"].keys() == {"src/app.py"}
    assert manifest["verified_hash"]
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    assert path.read_bytes() == body


@pytest.mark.parametrize("front", ['covers: []', 'covers: ["../outside.py"]', 'other: []', 'covers: "src/**"'])
def test_invalid_coverage_cannot_be_confirmed(project, front):
    path = project / "tests/workflow/app.md"
    path.write_text(path.read_text().replace('covers: ["src/**/*.py"]', front), encoding="utf-8")
    assert cli(project, "--directory", "tests/workflow", "status")[1]["workflows"][0]["state"] == "invalid"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 2
    assert not path.with_suffix(".manifest.json").exists()


def test_coverage_changes_in_markdown_update_the_generated_inventory(project):
    path = project / "tests/workflow/app.md"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    (project / "src/other.py").write_text("other", encoding="utf-8")
    path.write_text(path.read_text().replace('covers: ["src/**/*.py"]', 'covers:\n  - src/other.py'), encoding="utf-8")
    code, status = cli(project, "status")
    assert code == 1
    assert status["workflows"][0]["changed_files"] == ["src/app.py", "src/other.py"]
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    manifest = json.loads(path.with_suffix(".manifest.json").read_text())
    assert set(manifest) == {"verified_hash", "verified_files"}
    assert set(manifest["verified_files"]) == {"src/other.py"}


@pytest.mark.parametrize("content", ["{", "[]", '{"covers": []}'])
def test_malformed_manifest_is_invalid(project, content):
    path = project / "tests/workflow/app.manifest.json"
    path.write_text(content, encoding="utf-8")
    assert cli(project, "status")[1]["workflows"][0]["state"] == "invalid"
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 2


def test_discovery_can_be_limited_to_a_workflow_folder(project):
    code, status = cli(project, "--directory", "tests/workflow", "status")
    assert code == 1
    assert [record["workflow"] for record in status["workflows"]] == ["tests/workflow/app.md"]


def test_workflows_with_arbitrary_names_have_independent_manifests(project):
    first = project / "tests/workflow/app.md"
    second = first.with_name("Other check.v2.md")
    second.write_text(first.read_text().replace('src/**/*.py', 'src/other.py'), encoding="utf-8")
    (project / "src/other.py").write_text("other", encoding="utf-8")
    assert cli(project, "confirm", "tests/workflow/app.md")[0] == 0
    assert cli(project, "confirm", "tests/workflow/Other check.v2.md")[0] == 0
    first_manifest = json.loads(first.with_suffix(".manifest.json").read_text())
    second_manifest = json.loads(second.with_suffix(".manifest.json").read_text())
    assert set(first_manifest["verified_files"]) == {"src/app.py", "src/other.py"}
    assert set(second_manifest["verified_files"]) == {"src/other.py"}
    (project / "src/app.py").write_text("changed", encoding="utf-8")
    code, status = cli(project, "status")
    assert code == 1
    assert {record["workflow"]: record["state"] for record in status["workflows"]} == {
        "tests/workflow/app.md": "stale", "tests/workflow/Other check.v2.md": "passed"}
