"""Background shell is a Pi-only payload owned by the catalogue installer."""

import json

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_background_shell_installs_and_removes_without_touching_instructions(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.dumps({"defaultTools": ["read", "powershell"], "theme": "light"})
    target.settings_path.write_text(settings, encoding="utf-8")
    instructions = target.install_root / "AGENTS.md"
    instructions.write_text("Personal instructions\n", encoding="utf-8")
    receipts = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(discover(), target, receipts)
    installer.reconcile({"background-shell"})
    extension = target.destination_path("extensions", ".harness-background-shell/index.ts")
    ui = extension.with_name("ui.ts")
    assert extension.is_file()
    assert ui.is_file()
    configured = target.read_settings()
    packages = configured.pop("packages")
    assert len(packages) == 1
    assert packages[0].startswith("npm:harness-pi-background-shell@file:")
    assert configured == json.loads(settings)
    assert instructions.read_text(encoding="utf-8") == "Personal instructions\n"
    installer.reconcile(set())
    assert not extension.exists()
    assert not ui.exists()
    assert target.read_settings() == json.loads(settings)
    assert instructions.read_text(encoding="utf-8") == "Personal instructions\n"


def test_background_shell_only_declares_pi():
    tool = discover()["background-shell"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    assert tool.support_for(Platform.CLAUDE).status is SupportStatus.UNSUPPORTED
    assert tool.support_for(Platform.CHATGPT).status is SupportStatus.UNSUPPORTED
    assert not tool.actions
