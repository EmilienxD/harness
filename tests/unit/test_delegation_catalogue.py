from __future__ import annotations

import pytest
import yaml

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
        "work-with-agent", "explore-with-agent", "prototype-with-agent",
        "websearch-with-agent", "brainstorm-with-agent",
        "address-with-agent", "review-with-agent", "reply-to-agent",
        "communication-hooks", "harness-cli",
    }.isdisjoint(tools)
    for name in ("subagents", "prototype", "websearch", "grill-me", "issue-readers"):
        assert tools[name].support_for("claude").status is SupportStatus.SUPPORTED
        assert tools[name].support_for("chatgpt").status is SupportStatus.SUPPORTED


def test_subagents_bundle_depends_on_the_standalone_companion_skills() -> None:
    tools = discover()
    assert names(tools["subagents"]) == {"prototype", "websearch", "grill-me", "issue-readers"}


def test_launch_resume_and_reply_skills_remain_user_only() -> None:
    destinations = {
        entry.dest: entry.source
        for entry in discover()["subagents"].expand("chatgpt")
    }
    for name in (
        "work-with-agent", "explore-with-agent", "prototype-with-agent",
        "websearch-with-agent", "brainstorm-with-agent",
        "address-with-agent", "review-with-agent", "reply-to-agent", "resume-agent",
    ):
        skill = destinations[f"{name}/SKILL.md"]
        _opening, frontmatter, _body = skill.read_text(encoding="utf-8").split("---", 2)
        assert yaml.safe_load(frontmatter)["disable-model-invocation"] is True
        metadata = destinations[f"{name}/agents/openai.yaml"]
        assert yaml.safe_load(metadata.read_text(encoding="utf-8"))["policy"]["allow_implicit_invocation"] is False


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_shared_subagents_skill_is_model_invocable(provider) -> None:
    destinations = {
        entry.dest: entry.source
        for entry in discover()["subagents"].expand(provider)
    }
    source = destinations["subagents-toolkit/SKILL.md"]
    _opening, frontmatter, _body = source.read_text(encoding="utf-8").split("---", 2)
    metadata = yaml.safe_load(frontmatter)
    assert metadata["name"] == "subagents-toolkit"
    assert metadata.get("disable-model-invocation", False) is False
    if provider == "chatgpt":
        interface = destinations["subagents-toolkit/agents/openai.yaml"]
        assert yaml.safe_load(interface.read_text(encoding="utf-8"))["policy"]["allow_implicit_invocation"] is True


def test_address_launcher_includes_model_instructions() -> None:
    source = discover()["subagents"].root / "address-with-agent" / "SKILL.md"
    _opening, _frontmatter, body = source.read_text(encoding="utf-8").split("---", 2)

    assert body.strip()


def test_review_launcher_includes_model_instructions() -> None:
    source = discover()["subagents"].root / "review-with-agent" / "SKILL.md"
    _opening, _frontmatter, body = source.read_text(encoding="utf-8").split("---", 2)

    assert body.strip()


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


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_subagents_install_and_removal_cover_the_complete_workflow(tmp_path, monkeypatch, provider) -> None:
    tools = discover()
    target = Target.for_project(tmp_path / "project", provider)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(tools, target, store)
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action))
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda _prepared: None)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda _action: None)

    installer.reconcile({"subagents"})
    assert target.destination_path("skills", "subagents-toolkit/SKILL.md").exists()
    metadata = target.destination_path("skills", "subagents-toolkit/agents/openai.yaml")
    assert metadata.exists() == (provider == "chatgpt")
    assert target.destination_path("skills", "work-with-agent/SKILL.md").exists()
    assert target.destination_path("skills", "prototype-with-agent/SKILL.md").exists()
    assert target.destination_path("skills", "address-with-agent/SKILL.md").exists()
    assert target.destination_path("skills", "review-with-agent/SKILL.md").exists()
    assert target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert target.destination_path("skills", "prototype/SKILL.md").exists()
    assert target.destination_path("skills", "websearch/SKILL.md").exists()
    assert target.destination_path("skills", "grill-me/SKILL.md").exists()
    assert target.destination_path("skills", "address-this/SKILL.md").exists()
    assert target.destination_path("skills", "review-this/SKILL.md").exists()
    assert target.destination_path("hooks", "issue_readers_hook.py").exists()
    assert not target.destination_path("hooks", "delegation_hook.py").exists()
    assert not target.gitignore_path.exists() or ".harness/runtime/" not in target.gitignore_path.read_text(encoding="utf-8")

    installer.reconcile(set())
    assert not target.destination_path("skills", "subagents-toolkit/SKILL.md").exists()
    assert not metadata.exists()
    assert not target.destination_path("skills", "prototype-with-agent/SKILL.md").exists()
    assert not target.destination_path("skills", "address-with-agent/SKILL.md").exists()
    assert not target.destination_path("skills", "review-with-agent/SKILL.md").exists()
    assert not target.destination_path("skills", "reply-to-agent/SKILL.md").exists()
    assert not target.destination_path("hooks", "delegation_hook.py").exists()
    assert ".harness/runtime/" not in target.gitignore_path.read_text(encoding="utf-8") if target.gitignore_path.exists() else True
