"""Pi tool exclusions are independently selectable and receipt-owned."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_exclude_unwanted_tools_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"theme": "light", "quietStartup": False})
    target.settings_path.write_text(settings, encoding="utf-8")
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    tools = discover()
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"exclude-unwanted-tools"})
    extension = target.destination_path("extensions", "harness-exclude-unwanted-tools/index.ts")
    assert extension.read_bytes() == (tools["exclude-unwanted-tools"].root / "pi/extension.ts").read_bytes()
    installer.reconcile(set())
    assert not extension.exists()
    assert neighbour.is_file()
    assert target.settings_path.read_text(encoding="utf-8") == settings


def test_exclude_unwanted_tools_is_pi_only():
    tool = discover()["exclude-unwanted-tools"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
