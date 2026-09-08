import json
import os
import subprocess
import sys

from harness_cli import sessions
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


def install(name, tmp_path):
    tool = discover()[name]
    target = Target.for_project(tmp_path / "project")
    manager = CatalogueInstaller({name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    manager.reconcile({name})
    return target


def test_auto_hook_blocks_standalone_invocation(tmp_path):
    target = install("auto", tmp_path)
    script = target.install_root / "hooks/auto.py"
    environment = os.environ.copy()
    for name in ("ABOARD_BRIDGE_PORT", "ABOARD_BRIDGE_TOKEN", "ABOARD_SESSION_ID"):
        environment.pop(name, None)
    result = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps({"prompt": "/auto --dry", "hook_event_name": "UserPromptSubmit"}),
        capture_output=True,
        text=True,
        env=environment,
    )
    assert result.returncode == 2
    assert "requires an active Aboard session" in result.stderr


def test_worker_skill_bodies_are_empty_placeholders():
    tools = discover()
    for name in ("implement", "review-afk", "review-hitl"):
        text = tools[name].expand("claude")[0].source.read_text(encoding="utf-8")
        assert text.rstrip().endswith("---")


def test_reply_hook_uses_stable_delivery_id_for_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda argv, environment, cwd: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda config: ["claude"])
    parent = sessions.launch()
    monkeypatch.setenv("HARNESS_SESSION_ID", parent)
    request, child = sessions.ask("question")
    monkeypatch.setenv("HARNESS_SESSION_ID", child)
    monkeypatch.setenv("HARNESS_REQUEST_ID", request)
    delivery = sessions.reply("answer")

    target = install("session-replies", tmp_path)
    script = target.install_root / "hooks/reply_delivery.py"
    environment = os.environ.copy()
    payload = json.dumps({"session_id": parent, "hook_event_name": "UserPromptSubmit"})
    first = subprocess.run(
        [sys.executable, str(script), "prompt"], input=payload, capture_output=True, text=True, env=environment, check=True
    )
    second = subprocess.run(
        [sys.executable, str(script), "prompt"], input=payload, capture_output=True, text=True, env=environment, check=True
    )
    assert delivery in first.stdout
    assert delivery in second.stdout
    assert "answer" in first.stdout
