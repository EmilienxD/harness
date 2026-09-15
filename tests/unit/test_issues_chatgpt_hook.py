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
COPY = ROOT / "harness/building/issue-writers/copy_message_as_issue.py"
ADAPTER = ROOT / "harness/building/issue-writers/issue_writers_hook.py"

core_spec = importlib.util.spec_from_file_location("issues_core", CORE)
core = importlib.util.module_from_spec(core_spec)
sys.modules["issues_core"] = core
assert core_spec.loader is not None
core_spec.loader.exec_module(core)

copy_spec = importlib.util.spec_from_file_location("copy_message_as_issue", COPY)
copy_hook = importlib.util.module_from_spec(copy_spec)
sys.modules["copy_message_as_issue"] = copy_hook
assert copy_spec.loader is not None
copy_spec.loader.exec_module(copy_hook)

adapter_spec = importlib.util.spec_from_file_location("issue_writers_hook", ADAPTER)
adapter = importlib.util.module_from_spec(adapter_spec)
assert adapter_spec.loader is not None
adapter_spec.loader.exec_module(adapter)


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
    assert (tmp_path / ".codex/hooks/copy_message_as_issue.py").is_file()
    for name in (
        "copy-message-as-issue",
        "draft-audit-issues",
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
    for event in ("Stop", "SessionEnd"):
        event_commands = [hook["command"] for hook in hooks["hooks"][event][0]["hooks"]]
        assert any("issue_writers_hook.py" in command for command in event_commands)
        assert any("--chatgpt" in command for command in event_commands)


def test_chatgpt_copies_the_latest_response_without_using_the_gateway(
    tmp_path, monkeypatch, capsys
):
    cache_root = tmp_path / "provider-cache"
    monkeypatch.setenv("HARNESS_COPY_MESSAGE_CACHE_DIR", str(cache_root))
    created = []
    monkeypatch.setattr(
        copy_hook,
        "gh_create_issue",
        lambda title, body: (created.append((title, body)) or True, "https://github.com/o/r/issues/9"),
    )
    base = {
        "session_id": "thr_copy",
        "cwd": str(tmp_path),
        "transcript_path": str(tmp_path / "rollout.jsonl"),
    }

    assert _run(
        {**base, "hook_event_name": "Stop", "last_assistant_message": "Latest answer"},
        monkeypatch,
        capsys,
    ) == {}
    result = _run(
        {
            **base,
            "hook_event_name": "UserPromptSubmit",
            "prompt": "Please use $copy-message-as-issue for that response",
        },
        monkeypatch,
        capsys,
    )

    assert result == {"decision": "block", "reason": "Saved: https://github.com/o/r/issues/9"}
    assert created == [("Report thr_copy", "Latest answer")]
    assert not (tmp_path / ".issues-gateway").exists()
    assert not copy_hook.cache_path(base).exists()


def test_chatgpt_session_end_cleans_cache_after_the_workspace_is_removed(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("HARNESS_COPY_MESSAGE_CACHE_DIR", str(tmp_path / "provider-cache"))
    workspace = tmp_path / "removed-worktree"
    workspace.mkdir()
    payload = {
        "session_id": "thr_removed",
        "cwd": str(workspace),
        "hook_event_name": "Stop",
        "last_assistant_message": "Latest answer",
    }
    copy_hook.capture(payload)
    cache = copy_hook.cache_path(payload)
    workspace.rmdir()

    assert _run(
        {**payload, "hook_event_name": "SessionEnd"}, monkeypatch, capsys
    ) is None
    assert not cache.exists()


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

    assert context
    batch = tmp_path / ".issues-gateway" / batch_id
    assert batch.is_dir()
    assert (tmp_path / ".issues-gateway/.gitignore").read_text() == "*\n"

    (batch / "issue-0.md").write_text("# Existing\n", encoding="utf-8")
    result = _run(payload, monkeypatch, capsys)
    assert result["hookSpecificOutput"]["additionalContext"]


@pytest.mark.parametrize(
    "prompt",
    [
        "$draft-audit-issues convert the audit",
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
                    "prompt": "Please run $publish-issues --dry",
                }
            )
        ),
    )

    adapter.main(["--chatgpt"])

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

    adapter.main(["--chatgpt"])

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
    assert context
