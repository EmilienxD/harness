"""Tests for the redirect-subagents hooks and their shared io module.

The hooks run as standalone scripts inside `.claude/hooks/`, so they're
imported by path like the other harness hook tests. Everything that would
touch a real provider (clauder, claude, the network) is stubbed or pointed at
tmp_path; what is pinned down is the decision logic: what gets redirected or
deferred, what gets built, and what results look like when they come back.
"""
import json
import sys
import time
import types
from pathlib import Path

import pytest

HOOK_DIR = (
    Path(__file__).resolve().parent.parent
    / "harness" / "redirect-subagents" / "claude" / "hooks"
)

sys.path.insert(0, str(HOOK_DIR))

import rs_io  # noqa: E402
import redirect_subagents_deny_PreToolUse_hook as deny_hook  # noqa: E402
import redirect_subagents_notify_PostToolUse_hook as notify_hook  # noqa: E402
import redirect_subagents_wait_hook as wait_hook  # noqa: E402


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """No inherited configuration; state and home live in tmp_path."""
    for name in ("REDIRECT_SUBAGENTS_CLAUDER_BIN", "REDIRECT_SUBAGENTS_BACKEND", "LOG_LEVEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(
        rs_io, "USER_CONFIG",
        tmp_path / "home" / ".claude" / "harness-redirect-subagents" / "subagents.json",
    )
    monkeypatch.chdir(tmp_path)
    return tmp_path


def run_hook(module, payload):
    """Invoke a hook main() with stdin payload, returning (exit_code, parsed stdout)."""
    import io

    old_stdin, old_stdout, old_argv = sys.stdin, sys.stdout, sys.argv
    sys.argv = [str(HOOK_DIR / f"{module.__name__}.py")]

    class Cap(io.StringIO):
        @property
        def buffer(self):
            return self._buffer

    cap = Cap()
    cap._buffer = io.BytesIO()
    sys.stdin = io.StringIO(json.dumps(payload) if payload is not None else "null")
    sys.stdout = cap
    try:
        with pytest.raises(SystemExit) as ei:
            module.main()
        out = cap.getvalue() + cap.buffer.getvalue().decode("utf-8", errors="replace")
        return ei.value.code, json.loads(out) if out.strip() else None
    finally:
        sys.stdin, sys.stdout, sys.argv = old_stdin, old_stdout, old_argv


def capture_emit(payload):
    class Cap:
        def __init__(self):
            import io
            self._buffer = io.BytesIO()

        @property
        def buffer(self):
            return self._buffer

    cap = Cap()
    old_stdout = sys.stdout
    sys.stdout = cap
    try:
        rs_io.emit_json_output(payload)
    finally:
        sys.stdout = old_stdout
    return cap.buffer.getvalue()


def write_project_config(tmp_path, data):
    path = tmp_path / ".claude" / "harness-redirect-subagents" / "subagents.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def make_finished_job(tmp_path, job_id, session_id, text, existing=False):
    """Write a job's on-disk state as a finished one. `existing` marks a job
    directory that is already there (a running job crossing the line)."""
    d = tmp_path / rs_io.JOBS_REL / job_id
    d.mkdir(parents=True, exist_ok=existing)
    (d / "stdout.log").write_bytes(text.encode("utf-8"))
    (d / "exit_code").write_text("0", encoding="utf-8")
    (d / "done").touch()
    (d / "meta.json").write_text(json.dumps({
        "job_id": job_id,
        "session_id": session_id,
        "agent": "Explore",
        "pid": 1,
        "started_at": 0.0,
        "finished_at": None,
        "delivered": False,
        "cmd": ["fake"],
    }), encoding="utf-8")
    return d


# --- rs_io: build_cmd -----------------------------------------------------


def test_build_cmd_full_entry():
    cmd = rs_io.build_cmd(
        {"profile": "myprofile", "model": "m", "effort": "low", "system_prompt": "sp"},
        "hello prompt",
    )
    assert cmd == ["clauder", "run", "myprofile", "-p", "--model", "m",
                   "--effort", "low", "--system-prompt", "sp"]
    assert rs_io.prompt_input(
        {"profile": "myprofile", "model": "m", "effort": "low"}, "hello prompt"
    ) == "hello prompt"


def test_build_cmd_unset_fields_drop():
    """A field the entry leaves out takes its flag with it."""
    cmd = rs_io.build_cmd({"profile": "myprofile"}, "p")
    assert cmd == ["clauder", "run", "myprofile", "-p"]


def test_build_cmd_unset_field_before_inline_prompt_drops_its_flag():
    """The template's own {prompt} must not shield a flag whose value is
    unset — that flag would swallow the prompt as its operand."""
    cmd = rs_io.build_cmd({"command": "my-cli;chat;--model;{model};{prompt}"}, "find it")
    assert cmd == ["my-cli", "chat", "find it"]


def test_build_cmd_consecutive_unset_fields_before_inline_prompt():
    cmd = rs_io.build_cmd(
        {"command": "cli;--model;{model};--effort;{effort};{prompt}"}, "go"
    )
    assert cmd == ["cli", "go"]


def test_build_cmd_valueless_flag_survives_a_dropped_prompt():
    """`-p` takes no operand, so it is never the orphan of a dropped value."""
    cmd = rs_io.build_cmd(
        {"command": "claude;-p;{prompt}", "_append_prompt": False}, "secret"
    )
    assert cmd == ["claude", "-p"]


def test_build_cmd_string_shorthand_is_self_backend():
    cfg = rs_io._normalize({"Explore": "auto"})["Explore"]
    cmd = rs_io.build_cmd(cfg, "do thing")
    assert cmd == ["claude", "-p", "--model", "auto"]
    assert rs_io.prompt_input(cfg, "first\n\nsecond") == "first\n\nsecond"


def test_profile_entry_uses_print_mode_and_multiline_stdin():
    cfg = rs_io._normalize({"Explore": {"profile": "myprofile", "effort": "low"}})["Explore"]
    prompt = "find and report:\n\n1. first\n2. second"
    assert rs_io.build_cmd(cfg, prompt) == [
        "clauder", "run", "myprofile", "-p", "--effort", "low"
    ]
    assert rs_io.prompt_input(cfg, prompt) == prompt


def test_build_cmd_append_prompt_off_strips_prompt():
    cmd = rs_io.build_cmd(
        {"command": "claude;-p;{prompt}", "_append_prompt": False}, "secret prompt"
    )
    assert cmd == ["claude", "-p"]


def test_build_cmd_clauder_bin_env_expands_launcher(monkeypatch):
    monkeypatch.setenv("REDIRECT_SUBAGENTS_CLAUDER_BIN", "uvx;--from;clauder;clauder")
    cmd = rs_io.build_cmd({"profile": "myprofile", "model": "m", "effort": "low"}, "x")
    assert cmd == ["uvx", "--from", "clauder", "clauder", "run", "myprofile",
                   "-p", "--model", "m", "--effort", "low"]


def test_build_cmd_backend_env_replaces_default_command(monkeypatch):
    monkeypatch.setenv(
        "REDIRECT_SUBAGENTS_BACKEND", "mycli;chat;--m;{model};{prompt}"
    )
    cmd = rs_io.build_cmd({"model": "m"}, "go")
    assert cmd == ["mycli", "chat", "--m", "m", "go"]


def test_emit_ascii_safe():
    payload = {"decision": "block", "reason": "Hi there! 👋 café — 中文"}
    raw = capture_emit(payload)
    assert raw.isascii()
    assert json.loads(raw.decode("ascii")) == payload


# --- rs_io: root anchoring and job state ----------------------------------


def test_root_anchors_then_walks_up(tmp_path):
    assert rs_io.root() == tmp_path
    sub = tmp_path / "a" / "b"
    sub.mkdir(parents=True)
    import os
    old = os.getcwd()
    try:
        os.chdir(sub)
        assert rs_io.root() == tmp_path
    finally:
        os.chdir(old)


def test_defer_and_pop_roundtrip():
    jid = rs_io.defer_job("Explore", "find stuff", "sess1")
    assert jid is not None
    payload = rs_io.pop_deferred("sess1")
    assert payload["agent"] == "Explore"
    assert payload["prompt"] == "find stuff"
    assert rs_io.pop_deferred("sess1") is None


def test_deferred_config_falls_back_to_claude_p(tmp_path):
    write_project_config(tmp_path, {"Explore": {"profile": "myprofile", "model": "m", "effort": "low"}})
    cfg = rs_io.deferred_config("Explore")
    assert cfg["command"] == "claude;-p;{prompt}"
    assert cfg["_append_prompt"] is False


# --- deny hook ------------------------------------------------------------


def test_deny_unknown_subagent_passes():
    code, out = run_hook(deny_hook, {
        "tool_name": "Agent",
        "tool_input": {"subagent_type": "Nope", "prompt": "hi"},
        "session_id": "s1",
    })
    assert code == 0 and out is None


def test_deny_bad_json_passes():
    code, out = run_hook(deny_hook, None)
    assert code == 0 and out is None


def test_deny_disabled_entry_passes(tmp_path):
    write_project_config(tmp_path, {
        "Explore": {"profile": "p", "model": "m", "effort": "low", "disabled": True}
    })
    code, out = run_hook(deny_hook, {
        "tool_name": "Agent",
        "tool_input": {"subagent_type": "Explore", "prompt": "hi"},
        "session_id": "s1",
    })
    assert code == 0 and out is None


def test_deny_foreground_success(tmp_path, monkeypatch):
    import subprocess
    write_project_config(tmp_path, {"Explore": {"profile": "p", "model": "m", "effort": "low"}})

    captured = {}

    def fake_run(cmd, **kwargs):
        captured.update(kwargs)
        return types.SimpleNamespace(returncode=0, stdout="Hi there! 👋", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(rs_io, "clauder_available", lambda: True)
    monkeypatch.setattr(deny_hook, "clauder_available", lambda: True)

    code, out = run_hook(deny_hook, {
        "tool_name": "Agent",
        "tool_input": {"subagent_type": "Explore", "prompt": "hi", "run_in_background": False},
        "session_id": "s1",
    })
    assert code == 0
    assert captured["encoding"] == "utf-8"
    assert captured["input"] == "hi"
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert "Hi there! 👋" in reason


def test_background_job_pipes_multiline_stdin(tmp_path):
    prompt = "find and report:\n\n1. first\n2. second"
    job_id = deny_hook.start_background_job(
        "Explore",
        [sys.executable, "-c", "import sys; print(sys.stdin.read(), end='')"],
        "s1",
        cwd=str(tmp_path),
        stdin_text=prompt,
    )
    deadline = time.monotonic() + 5
    while not rs_io.is_done(job_id) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rs_io.is_done(job_id)
    assert rs_io.job_result(job_id) == (True, prompt)


def test_deny_defers_when_clauder_missing(tmp_path, monkeypatch):
    import shutil
    write_project_config(tmp_path, {"Explore": {"profile": "p", "model": "m", "effort": "low"}})
    monkeypatch.setattr(shutil, "which", lambda _x: None)

    code, out = run_hook(deny_hook, {
        "tool_name": "Agent",
        "tool_input": {"subagent_type": "Explore", "prompt": "find it"},
        "session_id": "s1",
    })
    assert code == 0
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert "deferred" in reason
    # The job got recorded for the fallback run.
    assert rs_io.pop_deferred("s1")["prompt"] == "find it"


def test_deny_delivers_pending_report_for_non_redirected_call(tmp_path):
    """An intercepted-looking but unconfigured Agent call still hands back
    any finished background job — the report beats the non-interception."""
    make_finished_job(tmp_path, "abc123def456", "s1", "job done")
    code, out = run_hook(deny_hook, {
        "tool_name": "Agent",
        "tool_input": {"subagent_type": "Nope", "prompt": "hi"},
        "session_id": "s1",
    })
    assert code == 0
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert "job done" in reason


# --- notify hook -----------------------------------------------------------


def test_notify_no_jobs_no_deferred_passes():
    code, out = run_hook(notify_hook, {"session_id": "nope"})
    assert code == 0 and out is None


def test_notify_delivers_finished_job(tmp_path):
    job_dir = make_finished_job(tmp_path, "abc123def456", "s1", "Hi there! 👋")
    code, out = run_hook(notify_hook, {"session_id": "s1"})
    assert code == 0
    assert out["decision"] == "block"
    assert "Hi there! 👋" in out["reason"]
    assert json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))["delivered"] is True


def test_notify_runs_deferred_via_fallback(tmp_path, monkeypatch):
    write_project_config(tmp_path, {"Explore": {"profile": "p", "model": "m", "effort": "low"}})
    rs_io.defer_job("Explore", "find it", "s1")

    captured = {}

    def fake_run(cmd, input=None, **kwargs):
        captured["cmd"] = cmd
        captured["input"] = input
        return types.SimpleNamespace(returncode=0, stdout="found it", stderr="")

    import subprocess as real_subprocess
    monkeypatch.setattr(real_subprocess, "run", fake_run)

    code, out = run_hook(notify_hook, {"session_id": "s1"})
    assert code == 0
    assert out["decision"] == "block"
    assert captured["cmd"] == ["claude", "-p"]
    assert captured["input"] == "find it"
    assert "found it" in out["reason"]


def test_notify_cleanup_removes_old_jobs(tmp_path):
    d = make_finished_job(tmp_path, "abc123def456", "s1", "x")
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    meta["delivered"] = True
    meta["finished_at"] = time.time() - 25 * 3600
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    old_mtime = time.time() - 25 * 3600
    import os
    os.utime(d / "meta.json", (old_mtime, old_mtime))

    notify_hook.cleanup()
    assert not d.exists()


# --- wait hook -------------------------------------------------------------


def test_wait_no_jobs_allows_stop():
    code, out = run_hook(wait_hook, {"session_id": "s1"})
    assert code == 0 and out is None


def test_wait_delivers_finished_job(tmp_path):
    make_finished_job(tmp_path, "abc123def456", "s1", "result text")
    code, out = run_hook(wait_hook, {"session_id": "s1"})
    assert code == 0
    assert out["decision"] == "block"
    assert "result text" in out["reason"]


def test_wait_timeout_allows_stop(tmp_path, monkeypatch):
    """A running job past the wait deadline lets the turn end, undelivered —
    the next turn's PreToolUse/PostToolUse hook picks it up."""
    d = tmp_path / rs_io.JOBS_REL / "abc123"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({
        "job_id": "abc123", "session_id": "s1", "agent": "Explore",
        "pid": 1, "started_at": time.time(), "finished_at": None,
        "delivered": False, "cmd": ["fake"],
    }), encoding="utf-8")
    monkeypatch.setattr(wait_hook, "WAIT_TIMEOUT_S", 0.01)
    monkeypatch.setattr(wait_hook, "POLL_INTERVAL_S", 0.001)

    code, out = run_hook(wait_hook, {"session_id": "s1"})
    assert code == 0 and out is None  # stop allowed, nothing claimed


def test_wait_stops_polling_once_jobs_are_delivered_elsewhere(tmp_path, monkeypatch):
    """Stop hooks run in parallel, so two waiters can race for one report.
    The loser must not keep polling to the deadline over finished work."""
    d = tmp_path / rs_io.JOBS_REL / "abc123"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({
        "job_id": "abc123", "session_id": "s1", "agent": "Explore",
        "pid": 1, "started_at": time.time(), "finished_at": None,
        "delivered": False, "cmd": ["fake"],
    }), encoding="utf-8")

    monkeypatch.setattr(wait_hook, "WAIT_TIMEOUT_S", 30)  # never reached
    monkeypatch.setattr(wait_hook, "POLL_INTERVAL_S", 0)

    polls = []

    def finish_then_deliver(*args, **kwargs):
        """Stand in for the winning waiter: the job lands, someone else takes it."""
        polls.append(1)
        if len(polls) == 2:
            make_finished_job(tmp_path, "abc123", "s1", "claimed by a sibling hook",
                              existing=True)
            rs_io.deliver_report(rs_io.open_job_ids("s1", done=True))

    monkeypatch.setattr(wait_hook.time, "sleep", finish_then_deliver)

    started = time.monotonic()
    code, out = run_hook(wait_hook, {"session_id": "s1"})
    assert code == 0 and out is None  # nothing left to claim, stop allowed
    assert time.monotonic() - started < 5  # returned on the poll, not the deadline


# --- delivery stays in the main conversation -------------------------------


def test_notify_inside_subagent_delivers_nothing(tmp_path):
    """A PostToolUse firing inside a delegate (agent_id present) must not
    deliver the main session's background reports into the delegate's turn."""
    make_finished_job(tmp_path, "abc123def456", "s1", "main-session result")
    code, out = run_hook(notify_hook, {"session_id": "s1", "agent_id": "sub-42"})
    assert code == 0 and out is None


def test_wait_inside_subagent_allows_stop(tmp_path):
    make_finished_job(tmp_path, "abc123def456", "s1", "main-session result")
    code, out = run_hook(wait_hook, {"session_id": "s1", "agent_id": "sub-42"})
    assert code == 0 and out is None
