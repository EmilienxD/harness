"""Catalogue installation seams for delivery packages."""
import json

import pytest
from harness_cli.manifest import discover
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.receipts import ReceiptStore
from harness_cli.host_actions import PreparedAction


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_ship_installs_workflow_runtime_hooks_and_dependencies(tmp_path, monkeypatch, provider):
    tools = discover()
    target = Target.for_project(tmp_path / "project", provider)
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    actions = []
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action))
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: actions.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda _action: None)
    installer.reconcile({"ship", "cleanup-git"})
    assert target.destination_path("hooks", "cleanup_git_hook.py").is_file()
    assert target.destination_path("skills", "cleanup-git/SKILL.md").is_file()
    assert target.destination_path("hooks", "ship_hook.py").is_file()
    assert target.destination_path("skills", "ship/SKILL.md").is_file()
    assert target.destination_path("skills", "ship/references/closeout.md").is_file()
    assert target.destination_path("skills", "ship/agents/openai.yaml").is_file() is (provider == "chatgpt")
    assert target.destination_path("skills", "test-workflows/SKILL.md").is_file()
    assert {"harness-test-workflows", "harness-subagents-runtime", "harness-issue-context", "harness-ship-contract"} <= {action.data.get("package") for action in actions}
    if provider == "claude":
        # Each implementer report continues the Lead's turn through its Stop hook.
        assert int(json.loads(target.settings_path.read_text(encoding="utf-8"))["env"]["CLAUDE_CODE_STOP_HOOK_BLOCK_CAP"]) > 8
    installer.reconcile(set())
    assert not target.destination_path("hooks", "ship_hook.py").exists()
    assert not target.destination_path("skills", "ship/SKILL.md").exists()
    if provider == "claude" and target.settings_path.is_file():
        assert "CLAUDE_CODE_STOP_HOOK_BLOCK_CAP" not in json.loads(target.settings_path.read_text(encoding="utf-8")).get("env", {})
