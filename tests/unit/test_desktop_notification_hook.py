"""The desktop command consumes prompts and opts only this session into Stop alerts."""
import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


PACKAGE = Path(__file__).resolve().parents[2] / "harness/productivity/enable-desktop-notification"


@pytest.fixture
def hook(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.syspath_prepend(str(PACKAGE))
    spec = importlib.util.spec_from_file_location("desktop_notification_hook", PACKAGE / "enable_desktop_notification_hook.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_enabling_consumes_command_and_notifies_only_that_session(hook, monkeypatch):
    notifications = []
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    monkeypatch.setattr(hook, "send_notification", lambda title, body: notifications.append((title, body)))
    prompt = {"hook_event_name": "UserPromptSubmit", "session_id": "session-one", "prompt": "/enable-desktop-notification"}
    assert hook.handle(prompt, "claude")["decision"] == "block"
    stop = {"hook_event_name": "Stop", "session_id": "session-one", "last_assistant_message": "Implemented the requested change."}
    assert hook.handle({**stop, "session_id": "session-two"}, "claude") == {}
    assert hook.handle(stop, "chatgpt") == {}
    assert hook.handle(stop, "claude") == {}
    assert notifications == [("Claude Code: session-one", "Implemented the requested change.")]


@pytest.mark.parametrize("provider,product", [("claude", "Claude Code"), ("chatgpt", "Codex")])
def test_notification_uses_latest_session_title_and_response_preview(hook, monkeypatch, tmp_path, provider, product):
    notifications = []
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    monkeypatch.setattr(hook, "send_notification", lambda title, body: notifications.append((title, body)))
    transcript = tmp_path / "session.jsonl"
    records = [
        {"type": "ai-title", "sessionId": "session-one", "aiTitle": "Previous title"},
        {"type": "ai-title", "sessionId": "session-one", "aiTitle": "Fix desktop alerts"},
        {"type": "ai-title", "sessionId": "other", "aiTitle": "Other session"},
    ]
    transcript.write_text("\n".join(json.dumps(record) for record in records) + "\n{partial", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "session_index.jsonl").write_text(
        json.dumps({"id": "session-one", "thread_name": "Fix desktop alerts"}) + "\n{partial", encoding="utf-8"
    )
    hook.handle({"hook_event_name": "UserPromptSubmit", "session_id": "session-one", "prompt": "/enable-desktop-notification"}, provider)
    hook.handle({"hook_event_name": "Stop", "session_id": "session-one", "transcript_path": str(transcript), "last_assistant_message": "Finished.\n\n" + "x" * 300}, provider)
    assert notifications == [(f"{product}: Fix desktop alerts", "Finished. " + "x" * 229 + "…")]


@pytest.mark.parametrize("provider,command", [("claude", "/enable-desktop-notification"), ("chatgpt", "$enable-desktop-notification")])
def test_disable_stops_notifications_and_other_prompts_pass_through(hook, monkeypatch, provider, command):
    notifications = []
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    monkeypatch.setattr(hook, "send_notification", lambda *args: notifications.append(args))
    prompt = {"hook_event_name": "UserPromptSubmit", "session_id": "session-one"}
    assert hook.handle({**prompt, "prompt": command}, provider)["decision"] == "block"
    assert hook.handle({**prompt, "prompt": f"Explain {command}"}, provider) == {}
    assert hook.handle({**prompt, "prompt": command + " --disable"}, provider)["decision"] == "block"
    hook.handle({"hook_event_name": "Stop", "session_id": "session-one", "last_assistant_message": "Done"}, provider)
    assert notifications == []


def test_direct_claude_skill_expansion_is_consumed(hook, monkeypatch):
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    assert hook.handle({"hook_event_name": "UserPromptExpansion", "command_name": "enable-desktop-notification", "command_args": "", "session_id": "session-one"}, "claude")["decision"] == "block"


def test_stop_with_unavailable_response_still_notifies(hook, monkeypatch):
    notifications = []
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    monkeypatch.setattr(hook, "send_notification", lambda *args: notifications.append(args))
    hook.handle({"hook_event_name": "UserPromptSubmit", "session_id": "session-one", "prompt": "/enable-desktop-notification"}, "chatgpt")
    hook.handle({"hook_event_name": "Stop", "session_id": "session-one", "last_assistant_message": None}, "chatgpt")
    assert notifications == [("Codex: session-one", "Turn completed.")]


def test_main_keeps_activation_errors_out_of_context_and_delivery_errors_nonblocking(hook, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "session-one", "prompt": "/enable-desktop-notification"}
    state = tmp_path / "state"
    state.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    assert hook.main(["--claude"]) == 0
    assert json.loads(capsys.readouterr().out)["decision"] == "block"
    state.unlink()
    hook.handle(payload, "claude")
    def unavailable(*args):
        raise RuntimeError("notification service unavailable")
    monkeypatch.setattr(hook, "send_notification", unavailable)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": "session-one", "last_assistant_message": "Done"})))
    assert hook.main(["--claude"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert "decision" not in output and "continue" not in output
    assert output["systemMessage"] == "Desktop notification failed: notification service unavailable"


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_hook_subprocess_outputs_valid_json_and_blocks_invalid_command(provider):
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "session-one", "prompt": "/enable-desktop-notification --unknown"}
    result = subprocess.run([sys.executable, str(PACKAGE / "enable_desktop_notification_hook.py"), "--" + provider], input=json.dumps(payload), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["decision"] == "block"
    assert result.stderr == ""


@pytest.mark.parametrize("provider,directory,events", [
    ("claude", ".claude", {"UserPromptSubmit", "UserPromptExpansion", "Stop"}),
    ("chatgpt", ".codex", {"UserPromptSubmit", "Stop"}),
])
def test_install_wires_native_hooks_and_uninstall_preserves_user_hook(tmp_path, monkeypatch, provider, directory, events):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    tool = discover()["enable-desktop-notification"]
    target = Target.for_project(tmp_path, platform=provider)
    settings = tmp_path / directory / ("settings.json" if provider == "claude" else "hooks.json")
    settings.parent.mkdir(parents=True)
    user_hook = {"hooks": [{"type": "command", "command": "user-notification-command"}]}
    settings.write_text(json.dumps({"hooks": {"Stop": [user_hook]}}), encoding="utf-8")
    installer = CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({tool.name})
    installed = tmp_path / directory / "hooks/enable_desktop_notification_hook.py"
    assert installed.is_file()
    assert (installed.parent / "desktop_notification.py").is_file()
    skills = ".claude/skills" if provider == "claude" else ".agents/skills"
    assert (tmp_path / skills / "enable-desktop-notification/SKILL.md").is_file()
    configured = json.loads(settings.read_text(encoding="utf-8"))["hooks"]
    assert set(configured) == events
    for event in events:
        native = next(entry for group in configured[event] for entry in group["hooks"] if "enable_desktop_notification_hook.py" in json.dumps(entry))
        launch = json.dumps(native)
        assert "--" + provider in launch
        assert "${PYTHON}" not in launch and "${HOOKS_DIR}" not in launch
    result = subprocess.run([sys.executable, str(installed), "--" + provider], input=json.dumps({"hook_event_name": "Stop", "session_id": "disabled-session"}), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == {}
    installer.reconcile(set())
    assert not installed.exists()
    assert json.loads(settings.read_text(encoding="utf-8"))["hooks"]["Stop"] == [user_hook]


def test_stop_main_decodes_utf8_notification_text(hook, monkeypatch, capsys):
    notifications = []
    monkeypatch.setattr(hook, "backend_available", lambda: True)
    monkeypatch.setattr(hook, "send_notification", lambda *args: notifications.append(args))
    hook.handle({"hook_event_name": "UserPromptSubmit", "session_id": "session-one",
                 "prompt": "/enable-desktop-notification"}, "claude")
    message = "caf\u00e9 \u65e5\u672c\u8a9e \U0001f600"
    payload = {"hook_event_name": "Stop", "session_id": "session-one", "last_assistant_message": message}
    stream = io.TextIOWrapper(io.BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
                              encoding="cp1252", errors="surrogateescape")
    monkeypatch.setattr(sys, "stdin", stream)
    assert hook.main(["--claude"]) == 0
    assert json.loads(capsys.readouterr().out) == {}
    assert notifications == [("Claude Code: session-one", message)]
