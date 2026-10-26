"""web-toolkit installation leaves provider configuration to the user."""

import json

import pytest

from harness_cli.host_actions import PreparedAction
from harness_cli.installer import CatalogueInstaller, Target, installed_packages
from harness_cli.manifest import discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.fixture
def installed_actions(monkeypatch):
    actions = []
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda action: PreparedAction(action))
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda _action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: actions.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda _action: None)
    return actions


def installer(tmp_path, platform):
    target = Target.for_project(tmp_path / "project", platform)
    return target, CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))


def test_claude_installs_skill_without_changing_settings(tmp_path, installed_actions):
    target, catalogue = installer(tmp_path, Platform.CLAUDE)
    target.settings_path.parent.mkdir(parents=True)
    target.settings_path.write_text(json.dumps({"permissions": {"deny": ["Bash(rm *)"]}}), encoding="utf-8")

    catalogue.reconcile({"web-toolkit"})

    assert json.loads(target.settings_path.read_text(encoding="utf-8")) == {"permissions": {"deny": ["Bash(rm *)"]}}
    assert target.destination_path("skills", "web-toolkit/SKILL.md").is_file()
    assert installed_actions == []

    catalogue.reconcile(set())

    assert json.loads(target.settings_path.read_text(encoding="utf-8")) == {"permissions": {"deny": ["Bash(rm *)"]}}
    assert not target.destination_path("skills", "web-toolkit/SKILL.md").exists()


def test_chatgpt_installs_skill_without_changing_config(tmp_path, installed_actions):
    target, catalogue = installer(tmp_path, Platform.CHATGPT)
    config = target.install_root / "config.toml"
    config.parent.mkdir(parents=True)
    original = '# my settings\nmodel = "gpt-6.1"  # pinned\nweb_search = "live"\n\n[sandbox_workspace_write]\nwritable_roots = ["/data"]\n'
    config.write_text(original, encoding="utf-8")

    catalogue.reconcile({"web-toolkit"})

    assert config.read_text(encoding="utf-8") == original
    assert target.destination_path("skills", "web-toolkit/agents/openai.yaml").is_file()
    assert installed_actions == []

    reloaded = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller(discover(), target, reloaded).reconcile(set())

    assert config.read_text(encoding="utf-8") == original
    assert not installed_packages(target, reloaded)


def test_chatgpt_does_not_create_config_when_absent(tmp_path, installed_actions):
    target, catalogue = installer(tmp_path, Platform.CHATGPT)
    config = target.install_root / "config.toml"

    catalogue.reconcile({"web-toolkit"})
    assert not config.exists()

    catalogue.reconcile(set())
    assert not config.exists()


def test_pi_installs_native_extension_without_fallback_skill(tmp_path, installed_actions):
    target, catalogue = installer(tmp_path, Platform.PI)

    catalogue.reconcile({"web-toolkit"})

    package = target.install_root / "npm/node_modules/harness-pi-web-toolkit"
    assert (package / "extensions/.harness-web-toolkit/index.ts").is_file()
    assert (package / "package.json").is_file()
    assert not (target.install_root / "extensions").exists()
    assert not (target.install_root / "harness/packages").exists()
    assert installed_actions == []
    catalogue.reconcile(set())
    assert not (target.install_root / "skills/web-toolkit").exists()
    assert not package.exists()
