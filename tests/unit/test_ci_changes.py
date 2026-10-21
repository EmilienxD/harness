import json
import subprocess

import pytest

from scripts import ci_changes


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["docs/user/index.md", "docs/CLAUDE-REFERENCES/hooks.md"], (False, False, False)),
        (["docs/protocol/grill/v1/round.schema.json"], (False, False, False)),
        (["apps/grill/src/routes/index.tsx"], (False, False, False)),
        (["apps/aboard/README.md"], (False, False, False)),
        (["README.md", "LICENSE"], (False, True, False)),
        (["harness/productivity/subagents/SKILL.md"], (True, True, True)),
        (["harness/productivity/subagents/runtime/src/subagents_runtime/sessions.py"], (True, True, True)),
        (["src/harness_cli/installer.py"], (True, True, True)),
        (["uv.lock"], (True, True, True)),
        (["tests/unit/test_sessions.py"], (True, True, False)),
        (["tests/conftest.py"], (True, True, False)),
        (["tests/e2e/core/claude.ts"], (False, True, True)),
        (["scripts/aboard_release.py"], (True, False, False)),
        (["apps/aboard/assets/runtime/abd_wrapper.py"], (True, False, False)),
        ([".github/workflows/ci.yml"], (True, True, True)),
        (["scripts/ci_changes.py"], (True, True, True)),
        (["tests/unit/test_ci_changes.py"], (True, True, True)),
        ([], (False, False, False)),
        (None, (True, True, True)),
    ],
)
def test_selects_checks_for_changed_inputs(paths, expected):
    assert tuple(ci_changes.select_jobs(paths).values()) == expected


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, text=True,
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path):
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.email", "ci-test@example.invalid")
    git(tmp_path, "config", "user.name", "CI test")
    payload = tmp_path / "harness/tool/SKILL.md"
    payload.parent.mkdir(parents=True)
    payload.write_text("initial payload", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial")
    return tmp_path


def test_pr_uses_merge_base_instead_of_base_only_changes(repository):
    git(repository, "checkout", "-b", "topic")
    docs = repository / "docs/user/index.md"
    docs.parent.mkdir(parents=True)
    docs.write_text("documentation", encoding="utf-8")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "docs")
    head = git(repository, "rev-parse", "HEAD")
    git(repository, "checkout", "main")
    (repository / "harness/tool/SKILL.md").write_text("base branch update", encoding="utf-8")
    git(repository, "commit", "-am", "base update")
    base = git(repository, "rev-parse", "HEAD")

    paths = ci_changes.changed_paths(
        "pull_request", {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}, repository,
    )

    assert paths == ["docs/user/index.md"]
    assert not any(ci_changes.select_jobs(paths).values())


def test_push_rename_out_of_payload_still_validates_package(repository):
    before = git(repository, "rev-parse", "HEAD")
    (repository / "docs").mkdir()
    git(repository, "mv", "harness/tool/SKILL.md", "docs/guide.md")
    git(repository, "commit", "-m", "move payload")
    after = git(repository, "rev-parse", "HEAD")

    paths = ci_changes.changed_paths("push", {"before": before, "after": after}, repository)

    assert set(paths) == {"harness/tool/SKILL.md", "docs/guide.md"}
    assert all(ci_changes.select_jobs(paths).values())


@pytest.mark.parametrize("before", ["0" * 40, "f" * 40, "invalid-ref"])
def test_missing_push_history_runs_checks(repository, before):
    paths = ci_changes.changed_paths(
        "push", {"before": before, "after": git(repository, "rev-parse", "HEAD")}, repository,
    )
    assert paths is None
    assert all(ci_changes.select_jobs(paths).values())


@pytest.mark.parametrize("event_name", ["schedule", "workflow_dispatch"])
def test_periodic_and_manual_runs_emit_full_coverage(tmp_path, monkeypatch, event_name):
    event_path = tmp_path / "event.json"
    event_path.write_text("{}", encoding="utf-8")
    output_path = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_EVENT_NAME", event_name)
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    monkeypatch.setenv("GITHUB_OUTPUT", str(output_path))

    ci_changes.main()

    outputs = dict(line.split("=", 1) for line in output_path.read_text().splitlines())
    assert all(outputs[name] == "true" for name in ci_changes.JOBS)
    matrix = json.loads(outputs["python_matrix"])
    assert set(matrix["os"]) == {"ubuntu-latest", "windows-latest"}
    assert set(matrix["python"]) == {"3.11", "3.13"}


def test_pr_keeps_minimum_python_and_windows_coverage():
    assert ci_changes.python_matrix(False) == {"include": [
        {"os": "ubuntu-latest", "python": "3.11"},
        {"os": "windows-latest", "python": "3.13"},
    ]}
