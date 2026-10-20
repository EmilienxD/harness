"""Tool inspector is independently selectable and receipt-owned at both Pi scopes."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_tool_inspector_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"theme": "light", "quietStartup": False})
    target.settings_path.write_text(settings, encoding="utf-8")
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"tool-inspector"})
    directory = target.destination_path("extensions", ".harness-tool-inspector")
    assert {p.name for p in directory.iterdir()} == {"index.ts", "startup.ts", "report.ts", "schema.ts"}
    installer.reconcile(set())
    assert not (directory / "index.ts").exists()
    assert neighbour.is_file()
    assert target.read_settings() == json.loads(settings)


def test_tool_inspector_is_pi_only():
    tool = discover()["tool-inspector"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
