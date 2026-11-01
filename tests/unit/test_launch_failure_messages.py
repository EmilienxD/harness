import json
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.usefixtures("loaded_subagents_integration")

from subagents_runtime import processes, sessions, bridge_backend
from subagents_runtime.delegation import claim_parent_delivery, enable_delegation, process_inbox

CODEX_REFUSAL = "Not inside a trusted directory and --skip-git-repo-check was not specified."


@pytest.fixture
def project(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    for name in ("HARNESS_SESSION_ID", "HARNESS_EXECUTION_ID", "HARNESS_BRIDGE_PORT", "HARNESS_BRIDGE_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(bridge_backend, "discover", lambda *_args, **_kwargs: None)
    return project


def provider_that_fails(tmp_path: Path, monkeypatch, *, stderr: str, code: int) -> None:
    script = tmp_path / "provider.py"
    script.write_text(f"import sys\nsys.stderr.write({stderr!r})\nsys.exit({code})\n", encoding="utf-8")
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: [sys.executable, str(script)])


def launch(project: Path, provider: str, mode: str):
    sessions.register_observed("parent", project, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text(f"---\nmode: {mode}\n---\nWork.", encoding="utf-8")
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    return result


def test_a_refused_headless_start_reports_the_providers_own_reason(project, tmp_path, monkeypatch):
    provider_that_fails(tmp_path, monkeypatch, stderr=f"Reading additional input from stdin...\n{CODEX_REFUSAL}\n", code=1)

    result = launch(project, "chatgpt", "auto")
    delivery = claim_parent_delivery("parent", "Stop")

    assert result.status == "failed"
    assert result.reason == f"Codex exited with code 1: {CODEX_REFUSAL}"
    assert CODEX_REFUSAL in delivery.text


def test_an_unconfirmed_visible_start_remains_uncertain(project, monkeypatch):
    monkeypatch.setattr(processes, "STARTUP_SECONDS", 0.2)
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: ["claude"])

    result = launch(project, "claude", "interactive")

    assert result.status == "uncertain"
    assert "Claude Code" in result.reason and str(project.resolve()) in result.reason
    assert claim_parent_delivery("parent", "Stop") is None


@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_silent_child_can_confirm_and_reply_after_startup_deadline(project, tmp_path, monkeypatch, mode):
    import subprocess
    import time

    script = tmp_path / "slow_provider.py"
    script.write_text(
        "import os, time, json\n"
        f"time.sleep({31 if mode == 'interactive' else 0.6})\n"
        "from subagents_runtime.processes import confirm_startup\n"
        "confirm_startup(os.environ['HARNESS_EXECUTION_ID'])\n"
        "from subagents_runtime.reply_support import acknowledge\n"
        "from pathlib import Path\n"
        "acknowledge(Path.cwd(), 'claude')\n"
        "from subagents_runtime.delegation import arm_reply, report_child_stop\n"
        "if os.environ['HARNESS_EXECUTION_MODE'] == 'interactive': arm_reply(os.environ['HARNESS_SESSION_ID'], os.environ['HARNESS_EXECUTION_ID'])\n"
        "report_child_stop(os.environ['HARNESS_SESSION_ID'], 'Completed', success=True, execution_id=os.environ['HARNESS_EXECUTION_ID'])\n"
        "print(json.dumps({'type': 'result', 'result': 'Completed'}), flush=True)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(processes, "STARTUP_SECONDS", 0.1)
    monkeypatch.setattr(sessions, "_command_from_config", lambda *_: [sys.executable, str(script)])
    children = []
    def terminal(command, environment, cwd):
        children.append(subprocess.Popen(command, env=environment, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    monkeypatch.setattr(sessions, "_visible_terminal", terminal)
    result = launch(project, "claude", mode)
    try:
        assert result.status == "uncertain"
        assert claim_parent_delivery("parent", "Stop") is None
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            with sessions._connect() as db:
                state = db.execute("SELECT state FROM requests WHERE id=?", (result.request_id,)).fetchone()[0]
            if state == "succeeded":
                break
            time.sleep(0.05)
        assert state == "succeeded"
        assert claim_parent_delivery("parent", "Stop") is not None
    finally:
        for child in children:
            child.wait(timeout=45)


def test_a_pi_crash_before_settlement_reports_its_stderr(project, tmp_path):
    root = tmp_path / "execution"
    root.mkdir()
    (root / "stderr.log").write_text("\x1b[31mError: No API key found for anthropic\x1b[0m\n", encoding="utf-8")
    run = processes.PiRun()

    _text, success, reason = run.outcome(1)

    assert success is False
    assert processes.with_detail(reason, processes.stderr_detail(root)) == "Pi exited with code 1: Error: No API key found for anthropic"


@pytest.mark.parametrize(("log", "detail"), [
    ("first\n\n  last line  \n\n", "last line"),
    ("", None),
    ("x" * 500, "x" * 299 + "…"),
])
def test_stderr_detail_keeps_one_bounded_line(tmp_path, log, detail):
    (tmp_path / "stderr.log").write_text(log, encoding="utf-8")
    assert processes.stderr_detail(tmp_path) == detail


def test_details_are_not_repeated():
    assert processes.with_detail("Codex exited with code 1: boom", "boom") == "Codex exited with code 1: boom"
    assert processes.with_detail("Startup failed", None) == "Startup failed"


def test_supervisor_reports_stderr_for_a_failed_pi_process(project, tmp_path, monkeypatch):
    launches = []
    monkeypatch.setattr(processes, "start", lambda execution_id, argv, environment, cwd, visible: launches.append((execution_id, environment)))
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: ["pi"])
    result = launch(project, "pi", "auto")
    execution_id, environment = launches[-1]
    script = tmp_path / "pi.py"
    script.write_text("import sys\nsys.stderr.write('Error: model is not configured\\n')\nsys.exit(2)\n", encoding="utf-8")
    specification = tmp_path / "launch.json"
    specification.write_text(json.dumps({"argv": [sys.executable, str(script)], "environment": environment, "cwd": str(project), "visible": False}), encoding="utf-8")

    processes.supervise(execution_id, specification)

    with sessions._connect() as connection:
        reason = connection.execute("SELECT reason FROM requests WHERE id=?", (result.request_id,)).fetchone()[0]
    assert reason == "Pi exited with code 2: Error: model is not configured"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows console allocation")
def test_headless_supervisor_never_allocates_a_visible_console(project, monkeypatch):
    import subprocess

    launched = []

    class Process:
        pid = 0

    def popen(command, **options):
        launched.append(options)
        return Process()

    monkeypatch.setattr(processes.subprocess, "Popen", popen)
    monkeypatch.setattr(processes, "STARTUP_SECONDS", 0.1)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider: ["codex"])

    launch(project, "chatgpt", "auto")

    [options] = launched
    assert options["creationflags"] & subprocess.CREATE_NO_WINDOW
    # DETACHED_PROCESS would make a venv's Python launcher open a console for the interpreter.
    assert not options["creationflags"] & subprocess.DETACHED_PROCESS
