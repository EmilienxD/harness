"""Provider-boundary failures must become event-specific Codex decisions."""

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "auto": "harness/vscode/auto/auto_hook.py",
    "commit": "harness/engineering/commit/commit_hook.py",
    "issue-writers": "harness/building/issue-writers/issue_writers_hook.py",
    "mid-prompt-skills": "harness/productivity/mid-prompt-skills/mid_prompt_skills_hook.py",
    "grill-me-in-cloud": "harness/planning/grill-me-in-cloud/grill_me_in_cloud_hook.py",
    "subagents": "harness/productivity/subagents/runtime/src/subagents_runtime/hooks.py",
    "no-new-documents": "harness/guards/no-new-documents/no_new_documents_hook.py",
    "command-guard": "harness/guards/command-guard/command_guard_hook.py",
    "ship": "harness/building/ship/ship_hook.py",
}
CASES = [
    ("auto", "UserPromptSubmit", "handle_prompt"),
    ("commit", "UserPromptSubmit", "chatgpt_main"),
    ("commit", "PreToolUse", "chatgpt_main"),
    ("commit", "PostToolUse", "chatgpt_main"),
    ("issue-writers", "UserPromptSubmit", "chatgpt_prompt"),
    ("mid-prompt-skills", "UserPromptSubmit", "handle"),
    ("grill-me-in-cloud", "UserPromptSubmit", "handle"),
    ("grill-me-in-cloud", "PostToolUse", "handle"),
    ("subagents", "UserPromptSubmit", "handle"),
    ("subagents", "PreToolUse", "handle"),
    ("subagents", "PostToolUse", "handle"),
    ("subagents", "SessionStart", "handle"),
    ("subagents", "Stop", "handle"),
    ("subagents", "Interrupt", "handle"),
    ("subagents", "SessionEnd", "handle"),
    ("no-new-documents", "PreToolUse", "guard_tool"),
    ("no-new-documents", "UserPromptSubmit", "handle_prompt"),
    ("command-guard", "PreToolUse", "check_action"),
    ("ship", "PreToolUse", "check"),
]


class Stream(io.StringIO):
    def reconfigure(self, **kwargs):
        pass


def load_hook(tool, monkeypatch):
    source = ROOT / SOURCES[tool]
    monkeypatch.syspath_prepend(str(source.parent))
    monkeypatch.syspath_prepend(str(ROOT / "harness/productivity/subagents/runtime/src"))
    spec = importlib.util.spec_from_file_location(f"failure_test_{tool.replace('-', '_')}", source)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def invoke(tool, hook, raw, monkeypatch, provider="chatgpt"):
    stdout, stderr = Stream(), Stream()
    monkeypatch.setattr(sys, "argv", [str(ROOT / SOURCES[tool]), f"--{provider}"])
    monkeypatch.setattr(sys, "stdin", Stream(raw))
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.setenv("HARNESS_EXECUTION_MODE", "loop" if tool == "ship" else "interactive")
    entry = hook.entrypoint if tool in {"commit", "issue-writers"} else hook.main
    try:
        code = entry() or 0
    except SystemExit as error:
        code = error.code
    return code, json.loads(stdout.getvalue()) if stdout.getvalue() else None, stderr.getvalue()


def assert_decision(output, event):
    if event == "UserPromptSubmit":
        assert output["decision"] == "block"
        reason = output["reason"]
    elif event == "PreToolUse":
        specific = output["hookSpecificOutput"]
        assert specific["hookEventName"] == event
        assert specific["permissionDecision"] == "deny"
        reason = specific["permissionDecisionReason"]
    elif event in {"PostToolUse", "SessionStart", "Stop"}:
        assert output["continue"] is False
        assert "decision" not in output  # Stop's block decision would restart the agent.
        reason = output["stopReason"]
    else:
        reason = output["systemMessage"]
    assert reason
    return reason


@pytest.mark.parametrize("tool,event,target", CASES)
def test_unexpected_failure_has_a_codex_decision(tool, event, target, monkeypatch):
    hook = load_hook(tool, monkeypatch)

    def fail(*args, **kwargs):
        raise RuntimeError("fixture dependency failure")

    monkeypatch.setattr(hook, target, fail)
    code, output, stderr = invoke(tool, hook, json.dumps({"hook_event_name": event}), monkeypatch)
    assert code == 0
    assert not stderr
    assert "fixture dependency failure" in assert_decision(output, event)


@pytest.mark.parametrize("tool", SOURCES)
def test_malformed_json_never_silently_succeeds(tool, monkeypatch):
    hook = load_hook(tool, monkeypatch)
    code, output, stderr = invoke(tool, hook, "{", monkeypatch)
    assert code == 0
    assert not stderr
    assert_decision(output, "PreToolUse" if tool in {"ship", "command-guard", "no-new-documents"} else "UserPromptSubmit")


@pytest.mark.parametrize("tool", ["auto", "commit", "issue-writers", "mid-prompt-skills", "grill-me-in-cloud", "subagents"])
def test_claude_failures_keep_exit_2(tool, monkeypatch):
    hook = load_hook(tool, monkeypatch)

    def fail(*args, **kwargs):
        raise RuntimeError("fixture dependency failure")

    target = {"auto": "handle_prompt", "commit": "claude_main", "issue-writers": "claude_prompt"}.get(tool, "handle")
    monkeypatch.setattr(hook, target, fail)
    code, output, stderr = invoke(tool, hook, "{}", monkeypatch, "claude")
    assert code == 2
    assert output is None
    assert "fixture dependency failure" in stderr
