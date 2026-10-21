"""Calm installs as an independent Pi extension with its upstream license."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_calm_install_and_removal_preserve_preferences_and_settings(tmp_path, monkeypatch, scope):
    agent_dir = tmp_path / "agent"
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(agent_dir))
    agent_dir.mkdir()
    preference = agent_dir / "calm"
    preference.write_text("on\n", encoding="utf-8")
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"theme": "light", "hideThinkingBlock": True})
    target.settings_path.write_text(settings, encoding="utf-8")
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"calm"})
    extension = target.install_root / "npm/node_modules/harness-pi-calm/extensions/.harness-calm/index.ts"
    assert extension.is_file()
    assert (extension.parent / "LICENSE").is_file()
    assert (extension.parent / "built-in-tool-shells.ts").is_file()
    installer.reconcile(set())
    assert not extension.exists()
    assert target.read_settings() == json.loads(settings)
    assert preference.read_text(encoding="utf-8") == "on\n"


def test_calm_only_supports_pi():
    tool = discover()["calm"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
