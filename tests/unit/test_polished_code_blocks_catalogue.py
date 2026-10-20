"""Polished code blocks are Pi-only and receipt-owned at either install scope."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_polished_code_blocks_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"theme": "light", "quietStartup": False})
    target.settings_path.write_text(settings, encoding="utf-8")
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"polished-code-blocks"})
    directory = target.destination_path("extensions", ".harness-polished-code-blocks")
    assert {p.name for p in directory.iterdir()} == {"index.ts", "renderer.ts"}
    installer.reconcile(set())
    assert not (directory / "index.ts").exists()
    assert neighbour.is_file()
    assert target.read_settings() == json.loads(settings)


def test_polished_code_blocks_is_pi_only():
    tool = discover()["polished-code-blocks"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
