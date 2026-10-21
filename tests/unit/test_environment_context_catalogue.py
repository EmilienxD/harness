"""Environment context is independently installable for Pi at either scope."""

import json
from pathlib import Path
import shutil
import subprocess

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_environment_context_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    original = {"theme": "light", "quietStartup": False}
    target.settings_path.write_text(json.dumps(original), encoding="utf-8")
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    tools = discover()
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"environment-context"})
    extension = target.install_root / "npm/node_modules/harness-pi-environment-context/extensions/.harness-environment-context/index.ts"
    assert extension.read_bytes() == (tools["environment-context"].root / "pi/extension.ts").read_bytes()
    settings = target.read_settings()
    assert len(settings["packages"]) == 1
    assert settings["packages"][0].startswith("npm:harness-pi-environment-context@file:")
    installer.reconcile({"environment-context"})
    assert target.read_settings() == settings
    installer.reconcile(set())
    assert not extension.exists()
    assert neighbour.is_file()
    assert target.read_settings() == original


def test_environment_context_is_pi_only():
    tool = discover()["environment-context"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    assert not tool.dependencies
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED


def test_environment_context_git_and_lifecycle():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for Pi extension tests")
    result = subprocess.run(
        [node, "--test", str(Path(__file__).with_name("environment_context.test.mjs"))],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
