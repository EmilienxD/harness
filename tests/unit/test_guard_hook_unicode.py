"""UTF-8 hook input must retain policy matches under legacy Windows encodings."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def run_hook(name, payload, project):
    source = ROOT / "harness/guards" / name / f"{name.replace('-', '_')}_hook.py"
    result = subprocess.run(
        [sys.executable, str(source)],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8", errors="backslashreplace"),
        capture_output=True,
        cwd=project,
        env=dict(os.environ, PYTHONIOENCODING="cp1252:surrogateescape",
                 CLAUDE_PROJECT_DIR=str(project), TEMP=str(project), TMP=str(project)),
    )
    assert (result.returncode, result.stderr) == (0, b"")
    return json.loads(result.stdout) if result.stdout else None


@pytest.mark.parametrize("name", ["on-edit-block", "on-edit-reminder", "on-read-reminder"])
def test_unicode_path_still_matches_required_reading(name, tmp_path):
    rules = tmp_path / ".harness/guards"
    rules.mkdir(parents=True)
    (rules / f"{name}.toml").write_text(
        'version=1\n[[rules]]\npatterns=["日本語/**"]\nrequire=["guide.md"]\n', encoding="utf-8"
    )
    (tmp_path / "guide.md").write_text("guidance", encoding="utf-8")
    output = run_hook(name, {
        "tool_name": "Read" if name == "on-read-reminder" else "Write",
        "tool_input": {"file_path": "日本語/code.py"},
    }, tmp_path)
    assert output is not None
    if name == "on-edit-block":
        assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    else:
        assert output["hookSpecificOutput"]["additionalContext"]


def test_unicode_command_matches_project_rule(tmp_path):
    rules = tmp_path / ".harness/guards"
    rules.mkdir(parents=True)
    (rules / "command-guard.toml").write_text(
        'version=1\n[[rules]]\nreason="blocked"\npatterns=["日本語"]\n', encoding="utf-8"
    )
    output = run_hook("command-guard", {"tool_input": {"command": "echo 日本語"}}, tmp_path)
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_unicode_comment_budget_counts_characters(tmp_path):
    output = run_hook("prefer-fewer-comments", {
        "tool_name": "Write", "tool_input": {"file_path": "code.py", "content": "# " + "😀" * 100},
    }, tmp_path)
    assert output is None


def test_unicode_document_path_matches_project_policy(tmp_path):
    rules = tmp_path / ".harness/guards"
    rules.mkdir(parents=True)
    (rules / "no-new-documents.toml").write_text(
        'version=1\nprotected=["日本語/**"]\n', encoding="utf-8"
    )
    output = run_hook("no-new-documents", {
        "tool_name": "Write", "tool_input": {"file_path": "日本語/plan.md", "content": "plan"},
    }, tmp_path)
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert (tmp_path / ".harness/doc-drafts").is_dir()


def load_hook(name, monkeypatch):
    path = ROOT / "harness/guards" / name / f"{name.replace('-', '_')}_hook.py"
    spec = importlib.util.spec_from_file_location(f"unicode_{name.replace('-', '_')}", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("name", ["on-edit-block", "on-edit-reminder"])
def test_lone_surrogate_cannot_crash_best_effort_marker(name, tmp_path, monkeypatch):
    hook = load_hook(name, monkeypatch)
    marker = tmp_path / "marker"
    if name == "on-edit-block":
        hook.mark_delivered(marker, ["bad\udcff.md"])
    else:
        hook.mark_reminded(marker, {}, ["bad\udcff.md"], 1.0)


@pytest.mark.parametrize("failure", ["root", "notice"])
def test_ordinary_prompt_survives_optional_notice_setup_failure(failure, monkeypatch, capsys):
    hook = load_hook("no-new-documents", monkeypatch)
    def fail(*args):
        raise UnicodeError("invalid path")
    monkeypatch.setattr(hook, "_root" if failure == "root" else "_notice_path", fail)
    assert hook.handle_prompt({"prompt": "continue"}) == 0
    assert capsys.readouterr().out == ""


def test_explicit_draft_command_retains_setup_failure(monkeypatch):
    hook = load_hook("no-new-documents", monkeypatch)
    with pytest.raises(UnicodeError):
        hook.handle_prompt({"prompt": "/approve-doc-draft", "session_id": "bad\udcff"})


def test_ordinary_prompt_with_surrogate_session_does_not_block(tmp_path):
    assert run_hook("no-new-documents", {
        "hook_event_name": "UserPromptSubmit", "prompt": "continue", "session_id": "bad\udcff",
    }, tmp_path) is None
