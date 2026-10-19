import importlib.util
import io
import json
import os
import subprocess
import sys
import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


def install(name, tmp_path, platform="claude"):
    tool = discover()[name]
    target = Target.for_project(tmp_path / "project", platform)
    manager = CatalogueInstaller({name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    manager.reconcile({name})
    return target


@pytest.mark.parametrize("platform", ["claude", "chatgpt"])
@pytest.mark.parametrize("prompt", ["/auto --dry", "$auto --dry", "[$auto](C:/project/.agents/skills/auto/SKILL.md)"])
def test_auto_hook_blocks_standalone_invocation(tmp_path, platform, prompt):
    target = install("auto", tmp_path, platform)
    script = target.install_root / "hooks/auto_hook.py"
    environment = os.environ.copy()
    for name in ("ABOARD_BRIDGE_PORT", "ABOARD_BRIDGE_TOKEN", "ABOARD_SESSION_ID"):
        environment.pop(name, None)
    result = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps({"prompt": prompt, "hook_event_name": "UserPromptSubmit"}),
        capture_output=True,
        text=True,
        env=environment,
    )
    assert result.returncode == 2
    assert "requires an active Aboard session" in result.stderr


def test_auto_installs_one_shared_skill_body_for_both_platforms(tmp_path):
    claude = install("auto", tmp_path / "claude", "claude")
    chatgpt = install("auto", tmp_path / "chatgpt", "chatgpt")

    claude_skill = (claude.install_root / "skills" / "auto" / "SKILL.md").read_text(encoding="utf-8")
    chatgpt_skill = chatgpt.destination_path("skills", "auto/SKILL.md").read_text(encoding="utf-8")
    assert chatgpt_skill == claude_skill
    hooks = json.loads(chatgpt.settings_path.read_text(encoding="utf-8"))
    command = hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert ".codex/hooks/auto_hook.py" in command


@pytest.mark.parametrize("prompt", ["/auto --dry", "$auto --dry", "[$auto](C:/project/.agents/skills/auto/SKILL.md) --dry"])
def test_auto_hook_prefers_the_runtime_session_id_from_chatgpt(tmp_path, monkeypatch, prompt):
    target = install("auto", tmp_path, "chatgpt")
    script = target.install_root / "hooks" / "auto_hook.py"
    spec = importlib.util.spec_from_file_location("auto_chatgpt_hook_test", script)
    assert spec is not None and spec.loader is not None
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    captured = {}

    class Response:
        def __enter__(self):
            return io.StringIO('{"message":"handled"}')

        def __exit__(self, *_args):
            return False

    def urlopen(request, timeout):
        captured.update(json.loads(request.data))
        return Response()

    monkeypatch.setenv("ABOARD_BRIDGE_PORT", "4823")
    monkeypatch.setenv("ABOARD_BRIDGE_TOKEN", "secret")
    monkeypatch.setenv("ABOARD_SESSION_ID", "provisional")
    monkeypatch.setattr(hook.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(hook.sys, "stdin", io.StringIO(json.dumps({
        "prompt": prompt,
        "hook_event_name": "UserPromptSubmit",
        "session_id": "runtime-assigned",
    })))
    monkeypatch.setattr(hook.sys, "stderr", io.StringIO())

    assert hook.main() == 2
    assert captured["sessionId"] == "runtime-assigned"
    assert captured["prompt"] == "/auto --dry"


def test_issue_readers_owns_both_worker_skills():
    tools = discover()
    assert {"issue-readers", "issue-writers"} <= tools.keys()
    assert "issues" not in tools

    destinations = {
        entry.dest: entry
        for entry in tools["issue-readers"].expand("claude")
    }
    for name in ("address-this", "review-this"):
        entry = destinations[f"{name}/SKILL.md"]
        text = entry.source.read_text(encoding="utf-8")
        assert text.split("---", 2)[2].strip()
        frontmatter, body = text.split("---", 2)[1:]
        assert "commit" not in next(
            line for line in frontmatter.splitlines() if line.startswith("description:")
        ).lower()
        assert "on success, commit" not in body.lower()
        assert "successful completion always produces exactly one commit" not in body.lower()
        assert "allow-empty" not in body.lower()
        assert entry.starter is True

    writer_destinations = {
        entry.dest
        for entry in tools["issue-writers"].expand("claude")
    }
    assert "address-this/SKILL.md" not in writer_destinations
    assert "review-this/SKILL.md" not in writer_destinations


def test_aboard_couples_auto_but_shares_issue_readers():
    dependencies = {dependency.name: dependency for dependency in discover()["aboard"].dependencies}

    assert dependencies["auto"].lifecycle == "coupled"
    assert dependencies["issue-readers"].lifecycle == "shared"


def test_aboard_supports_pi_and_uses_the_pi_enabled_release():
    tool = discover()["aboard"]

    assert tool.support_for("pi").status.value == "supported"
    action = next(action for action in tool.actions if action.type == "vscode-extension")
    assert action.data["url"].endswith("/aboard-v0.3.9/aboard-0.3.9.vsix")
