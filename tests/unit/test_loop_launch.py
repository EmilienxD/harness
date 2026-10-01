"""Loop launch contracts at the runtime CLI and configuration boundary."""

import json
import io
import os
from pathlib import Path
import subprocess
import sys
import tomllib

import pytest

from subagents_runtime import sessions
from subagents_runtime.cli import main


def test_loop_defaults_and_difficulty_routing(tmp_path):
    assert sessions.loop_configuration({"version": 1}) == {
        "maxFeedback": 3, "maxImplementers": 2, "freshContextPercent": 65,
    }
    config = {"version": 1, "providers": {
        "claude": {"delegations": {"loop": {"model": "by-difficulty"}}},
        "chatgpt": {"delegations": {"loop": {"model": "by-difficulty"}}},
    }}
    assert sessions.delegation_profile_arguments(config, "claude", "loop", difficulty="routine") == [
        "--model", "haiku", "--effort", "medium",
    ]
    assert sessions.delegation_profile_arguments(config, "chatgpt", "loop", difficulty="basic") == [
        "--model", "gpt-5.6-terra", "-c", 'model_reasoning_effort="high"',
    ]
    assert sessions.delegation_profile_arguments(config, "claude", "loop") == [
        "--model", "opus", "--effort", "high",
    ]
    config["providers"]["claude"]["delegations"]["loop"]["effort"] = "low"
    assert sessions.delegation_profile_arguments(config, "claude", "loop", difficulty="expert")[-1] == "low"


@pytest.mark.parametrize("value", [
    {"maxFeedback": -1}, {"maxFeedback": True}, {"maxImplementers": 0},
    {"maxImplementers": 1.5}, {"freshContextPercent": 101}, {"freshContextPercent": float("nan")},
])
def test_invalid_loop_limits_refuse_configuration(tmp_path, monkeypatch, value):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    (tmp_path / ".harness").mkdir()
    (tmp_path / ".harness/config.json").write_text(json.dumps({"version": 1, "loop": value}), encoding="utf-8")
    with pytest.raises(sessions.SessionError, match="loop"):
        sessions.launch_configuration(tmp_path)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_loop_cli_launches_visible_child_in_worktree_and_refuses_duplicate(provider, tmp_path, monkeypatch, capsys):
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setenv("HARNESS_SESSION_ID", "lead")
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: tmp_path / "no-endpoints")
    sessions.register_observed("lead", tmp_path, provider)
    worktree = tmp_path / "feature"
    (worktree / ".harness").mkdir(parents=True)
    (worktree / ".harness/config.json").write_text(json.dumps({
        "version": 1, "providers": {provider: {
            "command": [sys.executable], "delegations": {"loop": {"model": "by-difficulty"}},
        }},
    }), encoding="utf-8")
    prompt = tmp_path / "implementer.md"
    prompt.write_text("Use the feature requirements and criteria in the supplied files.", encoding="utf-8")
    launches = []

    def terminal(argv, environment, cwd):
        # Replace only the operating-system terminal adapter. The runtime still
        # reserves, configures and supervises the actual launch contract.
        spec = json.loads(Path(argv[-1]).read_text(encoding="utf-8"))
        launches.append(spec)
        from subagents_runtime.processes import confirm_startup
        confirm_startup(environment["HARNESS_EXECUTION_ID"])

    monkeypatch.setattr(sessions, "_visible_terminal", terminal)
    arguments = ["loop", "launch", "--cwd", str(worktree), "--prompt-file", str(prompt), "--difficulty", "routine"]
    assert main(arguments) == 0
    launched = json.loads(capsys.readouterr().out)
    assert launched["provider"] == provider
    assert launched["execution_mode"] == "loop"
    assert launched["parent_session_id"] == "lead"
    assert launched["active"] is True
    assert len(launches) == 1
    spec = launches[0]
    assert spec["cwd"] == str(worktree.resolve())
    assert spec["visible"] is True
    assert spec["environment"]["HARNESS_EXECUTION_MODE"] == "loop"
    assert spec["environment"]["HARNESS_SESSION_ID"] == launched["session_id"]
    assert "exec" not in spec["argv"] and "-p" not in spec["argv"]
    assert spec["argv"][spec["argv"].index("--model") + 1] == ("haiku" if provider == "claude" else "gpt-5.6-luna")
    if provider == "chatgpt":
        config = tomllib.loads((tmp_path / "codex/config.toml").read_text(encoding="utf-8"))
        assert config["projects"][str(worktree.resolve())]["trust_level"] == "trusted"
    assert main(["loop", "lookup", launched["session_id"]]) == 0
    assert json.loads(capsys.readouterr().out)["session_id"] == launched["session_id"]
    assert main(arguments) == 1
    assert len(launches) == 1
    assert "active loop implementer" in capsys.readouterr().err


@pytest.mark.parametrize("inline", [False, True])
def test_codex_trust_preserves_unrelated_configuration_and_is_idempotent(tmp_path, monkeypatch, inline):
    from subagents_runtime.codex_trust import trust_worktree
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    path = tmp_path / "codex/config.toml"
    path.parent.mkdir()
    worktree = tmp_path / "worktree"
    key = json.dumps(str(worktree.resolve()))
    text = '# Keep my configuration comments.\nmodel = "custom"\n'
    text += (f'projects = {{ {key} = {{ trust_level = "untrusted", note = "keep" }} }}\n' if inline
             else f'[projects.{key}]\ntrust_level = "untrusted" # Keep this too.\nnote = "keep"\n')
    path.write_text(text, encoding="utf-8")
    expected = tomllib.loads(text)
    expected["projects"][str(worktree.resolve())]["trust_level"] = "trusted"
    trust_worktree(worktree)
    first = path.read_text(encoding="utf-8")
    assert tomllib.loads(first) == expected
    assert "# Keep my configuration comments." in first
    trust_worktree(worktree)
    assert path.read_text(encoding="utf-8") == first


def test_loop_uses_initialized_aboard_window_for_a_registered_sibling_worktree(tmp_path, monkeypatch):
    from subagents_runtime.loop import launch
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("ABOARD_BRIDGE_PORT", raising=False)
    monkeypatch.delenv("ABOARD_BRIDGE_TOKEN", raising=False)
    root = tmp_path / "project"
    worktree = tmp_path / "feature"
    subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "worktree", "add", "-b", "feature", str(worktree)], check=True, capture_output=True)
    endpoints = tmp_path / "endpoints"
    endpoints.mkdir()
    (endpoints / "window.json").write_text(json.dumps({
        "version": 2, "host": "127.0.0.1", "port": 4823, "delegationToken": "scoped",
        "workspaceRoot": str(root), "pid": os.getpid(), "activatedAt": "2026-09-30T00:00:00Z",
    }), encoding="utf-8")
    monkeypatch.setattr(sessions, "_endpoint_directory", lambda: endpoints)
    observed = []

    def urlopen(request, timeout):
        observed.append(json.loads(request.data))
        return io.BytesIO(b'{"sessionId":"provider-child","agentId":"agent-1","terminalId":"visible"}')

    monkeypatch.setattr(sessions.urllib.request, "urlopen", urlopen)
    sessions.register_observed("lead", root, "claude")
    prompt = tmp_path / "prompt.md"
    prompt.write_text("Read the feature criteria.", encoding="utf-8")
    result = launch("lead", worktree, prompt, difficulty="basic")
    assert result["provider_session_id"] == "provider-child"
    assert observed[0]["mode"] == "loop"
    assert observed[0]["task"] == "loop"
    assert observed[0]["difficulty"] == "basic"
    assert observed[0]["cwd"] == str(worktree.resolve())
    assert observed[0]["harnessSessionId"] == result["session_id"]
    assert sessions._discover_delegation_endpoint(worktree) is None
