"""Regression tests for the native ChatGPT issues hook adapter."""

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "harness/building/issue-writers/issues_core.py"
ADAPTER = ROOT / "harness/building/issue-writers/issue_writers_hook.py"

core_spec = importlib.util.spec_from_file_location("issues_core", CORE)
core = importlib.util.module_from_spec(core_spec)
sys.modules["issues_core"] = core
assert core_spec.loader is not None
core_spec.loader.exec_module(core)

adapter_spec = importlib.util.spec_from_file_location("issue_writers_hook", ADAPTER)
adapter = importlib.util.module_from_spec(adapter_spec)
assert adapter_spec.loader is not None
adapter_spec.loader.exec_module(adapter)


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    """Keep locks and notices out of the developer's real home directory."""
    monkeypatch.setenv(core.STATE_DIR_VARIABLE, str(tmp_path / "state"))


def _run(payload, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    adapter.main(["--chatgpt"])
    output = capsys.readouterr().out
    return json.loads(output) if output else None


def test_chatgpt_install_uses_native_hook_and_skill_roots(tmp_path):
    tool = discover()["issue-writers"]
    target = Target.for_project(tmp_path, platform="chatgpt")
    CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json")).reconcile({tool.name})

    assert (tmp_path / ".codex/hooks/issues_core.py").is_file()
    assert (tmp_path / ".codex/hooks/issue_writers_hook.py").is_file()
    for name in (
        "draft-issue",
        "draft-issues",
        "publish-issues",
        "to-spec",
        "to-spec-draft-issue",
    ):
        skill = tmp_path / f".agents/skills/{name}"
        assert (skill / "SKILL.md").is_file()
        assert (skill / "agents/openai.yaml").is_file()
    assert not (tmp_path / ".claude").exists()

    hooks = json.loads((tmp_path / ".codex/hooks.json").read_text(encoding="utf-8"))
    commands = [hook["command"] for hook in hooks["hooks"]["UserPromptSubmit"][0]["hooks"]]
    assert any("issue_writers_hook.py" in command for command in commands)
    assert any("--chatgpt" in command for command in commands)
    assert all("${" not in command for command in commands)
def test_drafting_prompt_injects_stable_session_and_next_index(
    tmp_path, monkeypatch, capsys
):
    payload = {
        "session_id": "thr_same-thread",
        "cwd": str(tmp_path),
        "hook_event_name": "UserPromptSubmit",
        "prompt": "$draft-issue add native ChatGPT support",
    }
    first = _run(payload, monkeypatch, capsys)["hookSpecificOutput"]
    batch_id = adapter.issues_session_id("thr_same-thread")

    assert first["hookEventName"] == "UserPromptSubmit"
    assert core.next_draft_path(tmp_path, batch_id).name == f"{batch_id}.issue-0.md"
    assert (tmp_path / ".harness/issue-drafts/.gitignore").read_text() == "*\n"

    drafts = tmp_path / ".harness/issue-drafts"
    (drafts / f"{batch_id}.issue-0.md").write_text("# Existing\n", encoding="utf-8")

    second = _run(payload, monkeypatch, capsys)["hookSpecificOutput"]
    assert second["hookEventName"] == "UserPromptSubmit"
    assert core.next_draft_path(tmp_path, batch_id).name == f"{batch_id}.issue-1.md"


@pytest.mark.parametrize(
    "prompt",
    [
        "$draft-issues break this down",
        "@to-spec-draft-issue",
        "/draft-issue legacy spelling",
    ],
)
def test_all_explicit_drafting_spellings_trigger_context(
    prompt, tmp_path, monkeypatch, capsys
):
    result = _run(
        {
            "session_id": "thr_spellings",
            "cwd": str(tmp_path),
            "prompt": prompt,
        },
        monkeypatch,
        capsys,
    )
    assert result["hookSpecificOutput"]["additionalContext"]


def test_chatgpt_publish_dry_run_uses_shared_oversized_body_logic(
    tmp_path, monkeypatch, capsys
):
    batch_id = adapter.issues_session_id("thr_oversized")
    drafts = tmp_path / ".harness/issue-drafts"
    drafts.mkdir(parents=True)
    draft = drafts / f"{batch_id}.issue-0.md"
    draft.write_text(
        "# Large issue\n\n> difficulty:advanced\n\n" + "x" * 70_000,
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "session_id": "thr_oversized",
                    "cwd": str(tmp_path),
                    "prompt": "Please run $publish-issues --dry",
                }
            )
        ),
    )

    adapter.main(["--chatgpt"])

    response = json.loads(capsys.readouterr().out)
    assert response["decision"] == "block"
    assert "2 parts (1 continuation comment(s))" in response["reason"]
    # A dry run touches nothing: the draft survives and no bookkeeping file
    # appears beside it.
    assert [path.name for path in drafts.iterdir()] == [draft.name]


def test_chatgpt_publish_is_scoped_to_the_current_session(
    tmp_path, monkeypatch, capsys
):
    current = adapter.issues_session_id("thr_current")
    other = adapter.issues_session_id("thr_other")
    drafts = tmp_path / ".harness/issue-drafts"
    drafts.mkdir(parents=True)
    # Both sessions share one flat directory, so scoping is the filename's job.
    for batch_id, title in ((current, "Current"), (other, "Other")):
        (drafts / f"{batch_id}.issue-0.md").write_text(
            f"# {title}\n\n> mode:afk\n\nbody\n", encoding="utf-8"
        )
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "session_id": "thr_current",
                    "cwd": str(tmp_path),
                    "prompt": "$publish-issues --dry",
                }
            )
        ),
    )

    adapter.main(["--chatgpt"])

    response = json.loads(capsys.readouterr().out)
    assert response["decision"] == "block"
    assert "Dry run complete: 1 issue(s) ready to publish" in response["reason"]


def test_pending_notice_and_drafting_context_are_combined(
    tmp_path, monkeypatch, capsys
):
    session_id = adapter.issues_session_id("thr_notice")
    core.queue_notice(
        tmp_path, session_id, [{"number": "42", "title": "Spec"}], 0
    )

    result = _run(
        {
            "session_id": "thr_notice",
            "cwd": str(tmp_path),
            "prompt": "$draft-issues split up the published spec",
        },
        monkeypatch,
        capsys,
    )
    assert result["hookSpecificOutput"]["additionalContext"]
    assert not core.notice_path(tmp_path, session_id).exists()
    assert core.next_draft_path(tmp_path, session_id).name == f"{session_id}.issue-0.md"
