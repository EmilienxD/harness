from __future__ import annotations

from harness_cli.manifest import SupportStatus, discover
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.receipts import ReceiptStore
from harness_cli.host_actions import PreparedAction


def names(tool) -> set[str]:
    return {dependency.name for dependency in tool.dependencies}


def test_catalogue_exposes_one_subagents_bundle_and_standalone_companion_skills() -> None:
    tools = discover()
    assert {"subagents", "prototype", "websearch", "grill-me", "issue-readers"} <= tools.keys()
    assert {
        "ask-agent", "ask-agent-to-explore", "ask-agent-to-prototype",
        "ask-agent-to-websearch", "ask-agent-to-brainstorm",
        "ask-agent-to-implement", "ask-agent-to-review", "reply-to-agent",
        "communication-hooks", "harness-cli",
    }.isdisjoint(tools)
    for name in ("subagents", "prototype", "websearch", "grill-me", "issue-readers"):
        assert tools[name].support_for("claude").status is SupportStatus.SUPPORTED
        assert tools[name].support_for("chatgpt").status is SupportStatus.SUPPORTED


def test_subagents_bundle_depends_on_the_standalone_companion_skills() -> None:
    tools = discover()
    assert names(tools["subagents"]) == {"prototype", "websearch", "grill-me", "issue-readers"}


def test_every_chatgpt_ask_skill_is_user_only() -> None:
    destinations = {
        entry.dest: entry.source
        for entry in discover()["subagents"].expand("chatgpt")
    }
    for name in (
        "ask-agent", "ask-agent-to-explore", "ask-agent-to-prototype",
        "ask-agent-to-websearch", "ask-agent-to-brainstorm",
        "ask-agent-to-implement", "ask-agent-to-review", "reply-to-agent",
    ):
        metadata = destinations[f"{name}/agents/openai.yaml"]
        assert "allow_implicit_invocation: false" in metadata.read_text(encoding="utf-8")


def test_subagents_hooks_invoke_the_installed_runtime_for_both_provider_schemas() -> None:
    tool = discover()["subagents"]
    claude = tool.fragment_for("claude")["hooks"]
    chatgpt = tool.fragment_for("chatgpt")["hooks"]
    common = {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"}
    assert common | {"StopFailure"} <= set(claude)
    assert common | {"Interrupt"} <= set(chatgpt)
    assert "StopFailure" not in chatgpt
    assert all(
        hook["command"] == "harness-subagents-hook" and hook["args"] == ["--claude"]
        for groups in claude.values()
        for group in groups
        for hook in group["hooks"]
    )
    assert all(
        hook["command"] == "harness-subagents-hook --chatgpt"
        for groups in chatgpt.values()
        for group in groups
        for hook in group["hooks"]
    )
    for hooks in (claude, chatgpt):
        assert "matcher" not in hooks["PostToolUse"][0]


def test_subagents_install_and_removal_cover_the_complete_workflow(tmp_path, monkeypatch) -> None:
    tools = discover()
    target = Target.for_project(tmp_path / "project", "chatgpt")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(tools, target, store)
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action))
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda _prepared: None)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda _action: None)

    installer.reconcile({"subagents"})
    assert target.destination_path("skills", "ask-agent/SKILL.md").exists()
    assert target.destination_path("skills", "ask-agent-to-prototype/SKILL.md").exists()
    assert target.destination_path("skills", "ask-agent-to-implement/SKILL.md").exists()
    assert target.destination_path("skills", "ask-agent-to-review/SKILL.md").exists()
    assert target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert target.destination_path("skills", "prototype/SKILL.md").exists()
    assert target.destination_path("skills", "websearch/SKILL.md").exists()
    assert target.destination_path("skills", "grill-me/SKILL.md").exists()
    assert target.destination_path("skills", "address-this/SKILL.md").exists()
    assert target.destination_path("skills", "review-this/SKILL.md").exists()
    assert target.destination_path("hooks", "issue_readers_hook.py").exists()
    assert not target.destination_path("hooks", "delegation_hook.py").exists()
    assert ".harness/runtime/" in target.gitignore_path.read_text(encoding="utf-8")

    installer.reconcile(set())
    assert not target.destination_path("skills", "ask-agent-to-prototype/SKILL.md").exists()
    assert not target.destination_path("skills", "ask-agent-to-implement/SKILL.md").exists()
    assert not target.destination_path("skills", "ask-agent-to-review/SKILL.md").exists()
    assert not target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert not target.destination_path("hooks", "delegation_hook.py").exists()
    assert ".harness/runtime/" not in target.gitignore_path.read_text(encoding="utf-8") if target.gitignore_path.exists() else True
