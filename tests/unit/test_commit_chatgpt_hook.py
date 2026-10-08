"""Regression tests for the commit hook's native ChatGPT section."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "harness/engineering/commit/commit_hook.py"

adapter_spec = importlib.util.spec_from_file_location("commit_hook_chatgpt", ADAPTER)
adapter = importlib.util.module_from_spec(adapter_spec)
assert adapter_spec.loader is not None
adapter_spec.loader.exec_module(adapter)
core = adapter


@pytest.fixture(autouse=True)
def chatgpt_provider():
    """Every test here runs the hook as the ChatGPT fragment invokes it."""
    adapter.set_provider("chatgpt")
    yield
    adapter.set_provider("claude")


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    (path / "agent.md").write_text("before\n", encoding="utf-8")
    (path / "user.md").write_text("before\n", encoding="utf-8")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")
    return path


def test_chatgpt_install_uses_native_hooks_and_skill_roots(tmp_path):
    tool = discover()["commit"]
    target = Target.for_project(tmp_path, platform="chatgpt")
    CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json")).reconcile({tool.name})

    assert (tmp_path / ".codex/hooks/commit_hook.py").is_file()
    assert (tmp_path / ".agents/skills/commit/SKILL.md").is_file()
    assert (tmp_path / ".agents/skills/commit/agents/openai.yaml").is_file()
    assert not (tmp_path / ".claude").exists()

    hooks = json.loads((tmp_path / ".codex/hooks.json").read_text(encoding="utf-8"))["hooks"]
    assert set(hooks) == {"PreToolUse", "PostToolUse", "UserPromptSubmit"}
    assert hooks["PreToolUse"][0]["matcher"] == "Bash|apply_patch"
    for groups in hooks.values():
        command = groups[0]["hooks"][0]["command"]
        assert "commit_hook.py" in command
        assert "--chatgpt" in command
        assert "${" not in command


def test_event_snapshots_commit_only_chatgpt_changes(repo, capsys):
    # This edit predates the tool call and belongs to the user.
    (repo / "user.md").write_text("user edit\n", encoding="utf-8")
    session = "thr-selective"
    root = adapter._session_dir(str(repo), session)
    payload = {
        "session_id": session,
        "turn_id": "turn-1",
        "tool_use_id": "call-1",
        "tool_name": "apply_patch",
        "tool_input": {"command": "*** Begin Patch"},
    }

    adapter._record_pre(payload, str(repo), root)
    (repo / "agent.md").write_text("agent edit\n", encoding="utf-8")
    adapter._record_post(payload, str(repo), root)

    scan = adapter._scan(root, str(repo))
    assert scan is not None
    assert [Path(path).name for path in scan.paths] == ["agent.md"]

    with pytest.raises(SystemExit) as stopped:
        adapter._handle_commit(
            {"session_id": session},
            str(repo),
            root,
            core.Flags(False, False),
            "agent change",
        )
    assert stopped.value.code == 2
    assert "Committed" in capsys.readouterr().err
    assert _git(repo, "show", "--pretty=", "--name-only", "HEAD").strip() == "agent.md"
    assert _git(repo, "log", "-1", "--pretty=%B").rstrip().endswith(
        "ChatGPT-session: thr-selective"
    )
    assert _git(repo, "status", "--porcelain").rstrip() == " M user.md"
    assert not root.exists()


def test_missing_pre_snapshot_forces_visible_whole_tree_fallback(repo):
    session = "thr-fallback"
    root = adapter._session_dir(str(repo), session)
    payload = {
        "session_id": session,
        "turn_id": "turn-1",
        "tool_use_id": "missing-pre",
        "tool_name": "Bash",
        "tool_input": {"command": "generate files"},
    }
    (repo / "agent.md").write_text("changed\n", encoding="utf-8")
    adapter._record_post(payload, str(repo), root)

    scan = adapter._scan(root, str(repo))
    assert scan is not None
    assert scan.unresolved == ["Bash call missing-pre: pre-tool snapshot unavailable"]
    assert core.changed_paths(scan) is None


def test_chatgpt_unhandled_hook_exception_blocks_with_exit_2(monkeypatch, capsys):
    monkeypatch.setattr(
        adapter,
        "main",
        lambda *_: (_ for _ in ()).throw(RuntimeError("adapter failure")),
    )

    with pytest.raises(SystemExit) as stopped:
        adapter.entrypoint(["--chatgpt"])

    assert stopped.value.code == 2
    stderr = capsys.readouterr().err
    assert "harness commit hook failed in ChatGPT" in stderr
    assert "RuntimeError: adapter failure" in stderr


def test_chatgpt_ai_key_uses_harness_local_config(repo, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    key = repo / ".harness/config.local.json"
    key.parent.mkdir()
    key.write_text(json.dumps({"version": 1, "commit": {"geminiApiKey": "chatgpt-key"}}), encoding="utf-8")

    assert core.find_api_key(str(repo)) == ("chatgpt-key", f"{key} (commit.geminiApiKey)")


def test_ai_key_uses_user_harness_config_but_not_committed_project_config(repo, tmp_path, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state_dir))
    project_config = repo / ".harness/config.json"
    project_config.parent.mkdir()
    project_config.write_text(json.dumps({"version": 1, "commit": {"geminiApiKey": "committed-secret"}}), encoding="utf-8")

    assert core.find_api_key(str(repo)) == (None, None)

    user_config = state_dir / "config.json"
    user_config.write_text(json.dumps({"version": 1, "commit": {"geminiApiKey": "user-secret"}}), encoding="utf-8")
    assert core.find_api_key(str(repo)) == ("user-secret", f"{user_config} (commit.geminiApiKey)")
