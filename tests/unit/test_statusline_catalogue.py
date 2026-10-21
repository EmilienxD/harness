"""The Pi footer is independently selectable and receipt-owned at either scope."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_statusline_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"theme": "light"})
    target.settings_path.write_text(settings, encoding="utf-8")
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"statusline"})
    extension = target.install_root / "npm/node_modules/harness-pi-statusline/extensions/.harness-statusline/index.ts"
    assert extension.is_file()
    installer.reconcile(set())
    assert not extension.exists()
    assert neighbour.is_file()
    assert target.read_settings() == json.loads(settings)


def test_statusline_is_pi_only():
    tool = discover()["statusline"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
