from __future__ import annotations

import tomllib

from harness_cli.host_actions import PreparedAction
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.receipts import ReceiptStore


def installer(target, store, monkeypatch, actions=None, removals=None):
    actions = [] if actions is None else actions
    removals = [] if removals is None else removals
    selected = CatalogueInstaller(discover(), target, store)
    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action)
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr(
        "harness_cli.installer.apply_host_action",
        lambda prepared: actions.append(prepared.action),
    )
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removals.append)
    return selected


def test_catalogue_declares_shared_dual_provider_runtime_and_claude_skill():
    tool = discover()["agent-launcher"]
    assert tool.version == "1.1.0"
    assert tool.support_for("claude").status is SupportStatus.SUPPORTED
    assert tool.support_for("chatgpt").status is SupportStatus.SUPPORTED
    assert len(tool.actions) == 1
    assert tool.actions[0].data["package"] == "harness-agent-launcher"
    assert "harness/productivity/agent-launcher/runtime" in tool.actions[0].data["source"]

    runtime = tomllib.loads((tool.root / "runtime" / "pyproject.toml").read_text(encoding="utf-8"))
    assert runtime["project"]["name"] == "harness-agent-launcher"
    assert runtime["project"]["scripts"] == {
        "cch": "agent_launcher.cli:claude_entrypoint",
        "cxh": "agent_launcher.cli:chatgpt_entrypoint",
    }

    claude_files = tool.expand("claude", "project")
    chatgpt_files = tool.expand("chatgpt", "project")
    assert any(item.dest.endswith("extend-claude-system-prompt/SKILL.md") for item in claude_files)
    assert not any(item.dest.endswith("SKILL.md") for item in chatgpt_files)
    expected_starters = {
        ".harness/agent-launcher/config.py",
        ".harness/agent-launcher/system-prompt.md",
        ".harness/agent-launcher/claude/settings.json",
        ".harness/agent-launcher/chatgpt/config.toml",
        ".harness/agent-launcher/extensions/__init__.py",
    }
    assert {item.dest for item in claude_files if item.starter} == expected_starters
    assert {item.dest for item in chatgpt_files if item.starter} == expected_starters

    skill = next(item.source for item in claude_files if item.dest.endswith("SKILL.md"))
    body = skill.read_text(encoding="utf-8")
    assert "disable-model-invocation: true" in body
    assert ".harness/agent-launcher/" in body
    assert "claude.system_prompt" in body
    assert "cch --hns-render" in body
    assert "cxh" not in body and "Codex" not in body


def test_project_starters_are_shared_but_skill_is_platform_specific(tmp_path, monkeypatch):
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude_target = Target.for_project(project, "claude")
    chatgpt_target = Target.for_project(project, "chatgpt")

    installer(claude_target, store, monkeypatch).reconcile({"agent-launcher"})
    root = project / ".harness" / "agent-launcher"
    assert (root / "config.py").is_file()
    assert (root / "system-prompt.md").is_file()
    assert (root / "claude" / "settings.json").is_file()
    assert (root / "chatgpt" / "config.toml").is_file()
    assert (root / "extensions" / "__init__.py").is_file()
    assert claude_target.destination_path(
        "skills", "extend-claude-system-prompt/SKILL.md"
    ).is_file()

    installer(chatgpt_target, store, monkeypatch).reconcile({"agent-launcher"})
    assert not chatgpt_target.destination_path(
        "skills", "extend-claude-system-prompt/SKILL.md"
    ).exists()


def test_user_install_has_no_project_starters_and_only_claude_gets_skill(tmp_path, monkeypatch):
    store = ReceiptStore.load(tmp_path / "receipts.json")
    claude = Target(tmp_path / "claude-user", Target.for_project(tmp_path, "claude").adapter, True)
    chatgpt = Target(tmp_path / "chatgpt-user", Target.for_project(tmp_path, "chatgpt").adapter, True)

    installer(claude, store, monkeypatch).reconcile({"agent-launcher"})
    installer(chatgpt, store, monkeypatch).reconcile({"agent-launcher"})
    assert not (claude.scope_root / ".harness" / "agent-launcher").exists()
    assert not (chatgpt.scope_root / ".harness" / "agent-launcher").exists()
    assert claude.destination_path("skills", "extend-claude-system-prompt/SKILL.md").is_file()
    assert not chatgpt.destination_path("skills", "extend-claude-system-prompt/SKILL.md").exists()


def test_modified_shared_starter_survives_upgrade_and_uninstall(tmp_path, monkeypatch):
    store = ReceiptStore.load(tmp_path / "receipts.json")
    target = Target.for_project(tmp_path / "project", "chatgpt")
    selected = installer(target, store, monkeypatch)
    selected.reconcile({"agent-launcher"})
    config = target.scope_root / ".harness" / "agent-launcher" / "config.py"
    config.write_text("# user configuration\n", encoding="utf-8")

    tool = discover()["agent-launcher"]
    object.__setattr__(tool, "version", "1.1.0")
    selected.available[tool.name] = tool
    selected.reconcile({"agent-launcher"})
    selected.reconcile(set())
    assert config.read_text(encoding="utf-8") == "# user configuration\n"


def test_installer_and_both_entrypoints_use_identical_starters(tmp_path, monkeypatch):
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installed = tmp_path / "installed"
    target = Target.for_project(installed, "chatgpt")
    installer(target, store, monkeypatch).reconcile({"agent-launcher"})

    from agent_launcher.cli import initialize

    initialized = tmp_path / "initialized"
    initialize(initialized)
    for relative in (
        "config.py",
        "system-prompt.md",
        "claude/settings.json",
        "chatgpt/config.toml",
        "extensions/__init__.py",
    ):
        assert (installed / ".harness" / "agent-launcher" / relative).read_bytes() == (
            initialized / ".harness" / "agent-launcher" / relative
        ).read_bytes()


def test_platform_installations_share_one_host_action_owner(tmp_path, monkeypatch):
    actions, removals = [], []
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude = installer(Target.for_project(project, "claude"), store, monkeypatch, actions, removals)
    chatgpt = installer(Target.for_project(project, "chatgpt"), store, monkeypatch, actions, removals)

    claude.reconcile({"agent-launcher"})
    chatgpt.reconcile({"agent-launcher"})
    assert len(actions) == 1

    claude.reconcile(set())
    assert removals == []
    chatgpt.reconcile(set())
    assert removals == actions
