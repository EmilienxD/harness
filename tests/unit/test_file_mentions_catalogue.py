"""Pi file mentions are independently installed and removed at both scopes."""

import shutil
import subprocess
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_file_mentions_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    neighbour = target.destination_path("extensions", "other.ts")
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("export default function () {}", encoding="utf-8")
    tools = discover()
    tool = tools["file-mentions"]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(platform).status is SupportStatus.UNSUPPORTED
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"file-mentions"})
    extension = target.destination_path("extensions", ".harness-file-mentions/index.ts")
    assert extension.read_bytes() == (tool.root / "pi/extension.ts").read_bytes()
    installer.reconcile(set())
    assert not extension.exists()
    assert neighbour.is_file()


def test_file_mentions_behavior():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for Pi extension tests")
    result = subprocess.run(
        [node, "--test", str(Path(__file__).with_name("file_mentions.test.mjs"))],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
