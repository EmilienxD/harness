"""Turn timer is independently selectable and installed through native Pi packages."""

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_turn_timer_install_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    target.settings_path.write_text('{"theme":"light"}', encoding="utf-8")
    tools = discover()
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"turn-timer"})
    extension = target.install_root / "npm/node_modules/harness-pi-turn-timer/extensions/.harness-turn-timer/index.ts"
    assert extension.read_bytes() == (tools["turn-timer"].root / "pi/extension.ts").read_bytes()
    installer.reconcile(set())
    assert not extension.exists()
    assert target.read_settings() == {"theme": "light"}


def test_turn_timer_is_pi_only():
    tool = discover()["turn-timer"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
