"""Regression tests for the native ChatGPT issues hook adapter."""

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

from harness_cli.installer import Target, apply_install, plan_install
from harness_cli.manifest import discover

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "harness/issues/shared/hooks/issues_core.py"
ADAPTER = ROOT / "harness/issues/chatgpt/hooks/issues_ChatGPT_hook.py"

core_spec = importlib.util.spec_from_file_location("issues_core", CORE)
core = importlib.util.module_from_spec(core_spec)
sys.modules["issues_core"] = core
assert core_spec.loader is not None
core_spec.loader.exec_module(core)

adapter_spec = importlib.util.spec_from_file_location("issues_ChatGPT_hook", ADAPTER)
adapter = importlib.util.module_from_spec(adapter_spec)
assert adapter_spec.loader is not None
adapter_spec.loader.exec_module(adapter)


def _run(payload, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    adapter.main()
    output = capsys.readouterr().out
    return json.loads(output) if output else None


def test_chatgpt_install_uses_native_hook_and_skill_roots(tmp_path):
    tool = discover()["issues"]
    target = Target.for_project(tmp_path, platform="chatgpt")
    apply_install(plan_install(tool, target))

    assert (tmp_path / ".codex/hooks/issues_core.py").is_file()
    assert (tmp_path / ".codex/hooks/issues_ChatGPT_hook.py").is_file()
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
    command = hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert "issues_ChatGPT_hook.py" in command
    assert "${" not in command


def test_drafting_prompt_injects_stable_session_and_next_index(
    tmp_path, monkeypatch, capsys
):
    payload = {
        "session_id": "thr_same-thread",
        "cwd": str(tmp_path),
        "hook_event_name": "UserPromptSubmit",
        "prompt": "$draft-issue add native ChatGPT support",
    }
    result = _run(payload, monkeypatch, capsys)
    context = result["hookSpecificOutput"]["additionalContext"]
    batch_id = adapter.gateway_session_id("thr_same-thread")

    assert f"issues session id: {batch_id}" in context
    assert "next free issue index: 0" in context
    batch = tmp_path / ".issues-gateway" / batch_id
    assert batch.is_dir()
    assert (tmp_path / ".issues-gateway/.gitignore").read_text() == "*\n"

    (batch / "issue-0.md").write_text("# Existing\n", encoding="utf-8")
    result = _run(payload, monkeypatch, capsys)
    assert "next free issue index: 1" in result["hookSpecificOutput"]["additionalContext"]


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
    assert "Issues gateway drafting context" in result["hookSpecificOutput"][
        "additionalContext"
    ]


def test_chatgpt_publish_dry_run_uses_shared_oversized_body_logic(
    tmp_path, monkeypatch, capsys
):
    batch_id = adapter.gateway_session_id("thr_oversized")
    batch = tmp_path / ".issues-gateway" / batch_id
    batch.mkdir(parents=True)
    (batch / "issue-0.md").write_text(
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
                    "prompt": "$publish-issues --dry",
                }
            )
        ),
    )

    adapter.main()

    response = json.loads(capsys.readouterr().out)
    assert response["decision"] == "block"
    assert "2 parts (1 continuation comment(s))" in response["reason"]
    assert (batch / "issue-0.md").is_file()
    assert not (tmp_path / ".issues-gateway/.state.json").exists()


def test_chatgpt_publish_is_scoped_to_the_current_session(
    tmp_path, monkeypatch, capsys
):
    current = adapter.gateway_session_id("thr_current")
    other = adapter.gateway_session_id("thr_other")
    for batch_id, title in ((current, "Current"), (other, "Other")):
        batch = tmp_path / ".issues-gateway" / batch_id
        batch.mkdir(parents=True, exist_ok=True)
        (batch / "issue-0.md").write_text(
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

    adapter.main()

    response = json.loads(capsys.readouterr().out)
    assert response["decision"] == "block"
    assert "Dry run complete: 1 issue(s) ready to publish" in response["reason"]


def test_pending_notice_and_drafting_context_are_combined(
    tmp_path, monkeypatch, capsys
):
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    core.queue_notice(
        [{"number": "42", "url": "https://example.test/42", "title": "Spec"}],
        0,
        gateway,
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
    context = result["hookSpecificOutput"]["additionalContext"]
    assert "#42" in context
    assert "Issues gateway drafting context" in context
