"""Behavioral tests for the usage-limit-wait hook's ChatGPT/Codex section."""

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

from harness_cli.manifest import SupportStatus, discover


HOOK = (
    Path(__file__).resolve().parents[2]
    / "harness"
    / "guards"
    / "usage-limit-wait"
    / "usage_limit_wait_hook.py"
)

spec = importlib.util.spec_from_file_location("usage_limit_wait_chatgpt_hook", HOOK)
assert spec and spec.loader
hook = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = hook
spec.loader.exec_module(hook)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for name in list(sys.modules["os"].environ):
        if name.startswith("USAGE_LIMIT_WAIT_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setattr(hook, "PROVIDER", hook.CHATGPT)


def test_hook_warns_from_codex_app_server_usage(monkeypatch, capsys):
    response = {
        "id": 2,
        "result": {
            "ordinaryUsageAllowed": True,
            "rateLimits": {
                "primary": {
                    "usedPercent": 95,
                    "windowDurationMins": 300,
                    "resetsAt": 1_800_000_000,
                },
                "secondary": {
                    "usedPercent": 51,
                    "windowDurationMins": 10_080,
                    "resetsAt": 1_800_400_000,
                },
                "credits": {"hasCredits": False, "unlimited": False, "balance": "0"},
            },
            "rateLimitResetCredits": {"availableCount": 2, "credits": None},
        },
    }

    calls = []

    class RecordingStdin(io.StringIO):
        def close(self):
            pass

    class FakeProcess:
        def __init__(self, argv, **kwargs):
            self.stdin = RecordingStdin()
            self.stdout = io.StringIO(
                json.dumps({"id": 1, "result": {"userAgent": "test"}}) + "\n"
                + json.dumps(response) + "\n"
            )
            self.returncode = None
            calls.append((argv, kwargs, self))

        def terminate(self):
            self.returncode = 0

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/codex")
    monkeypatch.setattr(hook.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(
        hook.subprocess, "run", lambda *a, **k: pytest.fail("used communicate-with-EOF app-server call")
    )
    monkeypatch.setattr(hook.sys, "stdin", io.StringIO(json.dumps({"session_id": "session-1"})))
    monkeypatch.setattr(hook.time, "time", lambda: 1_799_996_400.0)

    assert hook.main(["--chatgpt"]) == 0

    output = json.loads(capsys.readouterr().out)
    assert output["systemMessage"].startswith("Codex usage: the 5-hour window is 95% used")
    assert calls[0][0] == ["/usr/bin/codex", "app-server", "--stdio"]
    requests = [json.loads(line) for line in calls[0][2].stdin.getvalue().splitlines()]
    assert requests[-1] == {
        "method": "account/rateLimits/read",
        "id": 2,
        "params": {"supportsLunaReserve": False, "excludeResetCreditDetails": True},
    }
    cached = hook.cache_path().read_text(encoding="utf-8")
    assert "rateLimitResetCredits" not in cached


def test_catalogue_installs_the_hook_at_both_codex_request_boundaries():
    tool = discover()["usage-limit-wait"]

    assert tool.support_for("chatgpt").status is SupportStatus.SUPPORTED
    hooks = tool.fragment_for("chatgpt")["hooks"]
    assert set(hooks) == {"UserPromptSubmit", "PostToolUse"}
    assert "matcher" not in hooks["PostToolUse"][0]
    assert all(
        handler["command"]
        == '${PYTHON} "${HOOKS_DIR}/usage_limit_wait_hook.py" --chatgpt'
        and handler["timeout"] == 604800
        for groups in hooks.values()
        for group in groups
        for handler in group["hooks"]
    )
    destinations = {entry.dest for entry in tool.expand("chatgpt")}
    assert "usage_limit_wait_hook.py" in destinations


def test_a_manually_redeemed_ticket_ends_the_wait_on_the_next_poll(monkeypatch):
    class Clock:
        def __init__(self):
            self.now = 1_000_000.0
            self.slept = []

        def time(self):
            return self.now

        def sleep(self, seconds):
            self.slept.append(seconds)
            self.now += seconds

    clock = Clock()
    reset_at = clock.now + 3600
    exhausted = {
        "source": "codex-app-server",
        "windows": [
            {"kind": "session", "percent": 100.0, "resets_at": reset_at},
            {"kind": "weekly_all", "percent": 100.0, "resets_at": reset_at + 3600},
        ],
        "credits": None,
    }
    restored = {
        "source": "codex-app-server",
        "windows": [
            {"kind": "session", "percent": 0.0, "resets_at": reset_at + 18_000},
            {"kind": "weekly_all", "percent": 0.0, "resets_at": reset_at + 604_800},
        ],
        "credits": None,
    }
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "60")

    waited, kind = hook.wait_for_reset(
        exhausted,
        now=clock.time,
        sleep=clock.sleep,
        refresh=lambda: restored,
    )

    assert clock.slept == [60]
    assert waited == 60
    assert kind == "session"


def test_app_server_failure_fails_open(monkeypatch, capsys):
    monkeypatch.setattr(hook.shutil, "which", lambda name: None)
    monkeypatch.setattr(hook.sys, "stdin", io.StringIO(json.dumps({"session_id": "session-1"})))

    assert hook.main(["--chatgpt"]) == 0
    assert capsys.readouterr().out == ""
