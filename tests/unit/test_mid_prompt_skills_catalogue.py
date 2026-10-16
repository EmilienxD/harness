"""Pi support installs only its native entry point, independently of Python hooks."""

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.mark.parametrize("scope", ["project", "user"])
def test_mid_prompt_skills_pi_install_and_remove(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user(Platform.PI) if scope == "user" else Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = '{"enableSkillCommands": false}\n'
    target.settings_path.write_text(settings, encoding="utf-8")
    tools = discover()
    tool = tools["mid-prompt-skills"]
    assert tool.version == "1.2.0"
    for provider in (Platform.PI, Platform.CLAUDE, Platform.CHATGPT):
        assert tool.support_for(provider).status is SupportStatus.SUPPORTED
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({tool.name})
    extension = target.destination_path("extensions", "harness-mid-prompt-skills/index.ts")
    assert extension.read_bytes() == (tool.root / "pi" / "extension.ts").read_bytes()
    assert not target.destination_path("hooks", "mid_prompt_skills_hook.py").exists()
    installer.reconcile(set())
    assert not extension.exists()
    assert target.settings_path.read_text(encoding="utf-8") == settings
