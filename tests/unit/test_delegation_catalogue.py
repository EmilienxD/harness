from __future__ import annotations

from dataclasses import replace

import pytest
import yaml

from harness_cli.manifest import SupportStatus, discover
from harness_cli.installer import CatalogueInstaller, Target, sha256
from harness_cli.receipts import ReceiptStore
from harness_cli.host_actions import PreparedAction
from subagents_runtime import roles


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


@pytest.mark.parametrize(("provider", "skill_mode"), [
    ("claude", "copy"), ("chatgpt", "copy"), ("claude", "symlink"),
])
def test_toolkit_upgrade_preserves_custom_registry_and_skill_pairs(tmp_path, monkeypatch, provider, skill_mode):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    tool = discover()["subagents"]
    source = tmp_path / "package" / "subagents-toolkit" / "SKILL.md"
    source.parent.mkdir(parents=True)
    source.write_bytes((tool.root / "subagents-toolkit" / "SKILL.md").read_bytes())
    builtin_registry = source.with_name("builtin-tasks.yaml")
    builtin_registry.write_bytes((tool.root / "subagents-toolkit" / "builtin-tasks.yaml").read_bytes())
    # Exercise the real toolkit payload without installing machine-level tools.
    old_tool = replace(
        tool, version="2.5.0", root=source.parents[1],
        files=tuple(spec for spec in tool.files if spec.src == "subagents-toolkit"),
        dependencies=(), actions=(), platform_fragments={},
    )
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    target = Target.for_project(project, provider)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller({tool.name: old_tool}, target, store, skill_mode=skill_mode)
    installer.reconcile({tool.name})

    custom = {
        "launcher": "security-with-agent", "skill": "security-audit",
        "modes": ["auto", "interactive"], "default-mode": "auto",
    }
    registry = project / ".harness" / "subagent-tasks.yaml"
    registry.parent.mkdir()
    registry.write_text(yaml.safe_dump({"security": custom}), encoding="utf-8")
    user_skills = []
    for name in ("security-with-agent", "security-audit"):
        path = target.destination_path("skills", f"{name}/SKILL.md")
        path.parent.mkdir(parents=True)
        path.write_text(f"---\nname: {name}\n---\nUser-owned workflow.\n", encoding="utf-8")
        user_skills.append(path)
    user_digests = {path: sha256(path) for path in (registry, *user_skills)}

    tasks = yaml.safe_load(builtin_registry.read_text(encoding="utf-8"))
    tasks["new-default"] = {**custom, "launcher": "new-default-with-agent"}
    builtin_registry.write_text(yaml.safe_dump(tasks), encoding="utf-8")
    installer.available = {tool.name: replace(old_tool, version=tool.version)}
    changes = installer.reconcile({tool.name})

    assert [(change.action, change.package) for change in changes] == [("upgrade", "subagents")]
    toolkit = roles.find_skill(project, provider, "subagents-toolkit")
    assert toolkit is not None
    assert sha256(toolkit) == sha256(source)
    assert sha256(toolkit.with_name("builtin-tasks.yaml")) == sha256(builtin_registry)
    assert roles.task_policy("security", project, provider).skill == "security-audit"
    assert roles.task_policy("new-default", project, provider).skill == "security-audit"
    assert {path: sha256(path) for path in user_digests} == user_digests
    managed = installer.installation["packages"][tool.name]["files"]
    assert {record["path"] for record in managed}.isdisjoint(str(path.resolve()) for path in user_digests)

    installer.reconcile(set())
    assert not toolkit.exists()
    assert not toolkit.with_name("builtin-tasks.yaml").exists()
    assert {path: sha256(path) for path in user_digests} == user_digests
