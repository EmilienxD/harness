from __future__ import annotations

from harness_cli.manifest import SupportStatus, discover
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.receipts import ReceiptStore
from harness_cli.host_actions import PreparedAction


def names(tool) -> set[str]:
    return {dependency.name for dependency in tool.dependencies}


def test_delegation_packages_expose_the_final_names_and_platforms() -> None:
    tools = discover()
    assert "ask-agent" in tools
    assert "reply-to-agent" in tools
    assert "communication-hooks" in tools
    assert "communicate-to-agent" not in tools
    for name in (
        "ask-agent", "ask-agent-to-explore", "ask-agent-to-prototype",
        "ask-agent-to-websearch", "ask-agent-to-brainstorm", "reply-to-agent",
        "communication-hooks",
    ):
        assert tools[name].support_for("claude").status is SupportStatus.SUPPORTED
        assert tools[name].support_for("chatgpt").status is SupportStatus.SUPPORTED


def test_specialized_ask_dependencies_match_the_task_contract() -> None:
    tools = discover()
    assert names(tools["ask-agent-to-explore"]) == {"harness-cli", "communication-hooks"}
    assert names(tools["ask-agent-to-prototype"]) == {"harness-cli", "communication-hooks", "prototype", "reply-to-agent"}
    assert names(tools["ask-agent-to-websearch"]) == {"harness-cli", "communication-hooks", "websearch", "reply-to-agent"}
    assert names(tools["ask-agent-to-brainstorm"]) == {"harness-cli", "communication-hooks", "grill-me", "reply-to-agent"}


def test_every_chatgpt_ask_skill_is_user_only() -> None:
    tools = discover()
    for name in (
        "ask-agent", "ask-agent-to-explore", "ask-agent-to-prototype",
        "ask-agent-to-websearch", "ask-agent-to-brainstorm", "reply-to-agent",
    ):
        metadata = [entry for entry in tools[name].expand("chatgpt") if entry.dest.endswith("agents/openai.yaml")]
        assert len(metadata) == 1
        assert "allow_implicit_invocation: false" in metadata[0].source.read_text(encoding="utf-8")


def test_communication_hooks_install_for_both_provider_schemas() -> None:
    tool = discover()["communication-hooks"]
    claude = tool.fragment_for("claude")["hooks"]
    chatgpt = tool.fragment_for("chatgpt")["hooks"]
    common = {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"}
    assert common | {"StopFailure"} <= set(claude)
    assert common | {"Interrupt"} <= set(chatgpt)
    assert "StopFailure" not in chatgpt
    for hooks in (claude, chatgpt):
        assert "matcher" not in hooks["PostToolUse"][0]


def test_receipt_driven_removal_cleans_transitive_delegation_payloads(tmp_path, monkeypatch) -> None:
    tools = discover()
    target = Target.for_project(tmp_path / "project", "chatgpt")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(tools, target, store)
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action))
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda _prepared: None)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda _action: None)

    installer.reconcile({"ask-agent-to-prototype"})
    assert target.destination_path("skills", "ask-agent-to-prototype/SKILL.md").exists()
    assert target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert target.destination_path("hooks", "delegation_hook.py").exists()
    assert ".harness/runtime/" in target.gitignore_path.read_text(encoding="utf-8")

    installer.reconcile(set())
    assert not target.destination_path("skills", "ask-agent-to-prototype/SKILL.md").exists()
    assert not target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert not target.destination_path("hooks", "delegation_hook.py").exists()
    assert ".harness/runtime/" not in target.gitignore_path.read_text(encoding="utf-8") if target.gitignore_path.exists() else True
