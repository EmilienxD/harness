#!/usr/bin/env python3
"""Redirect built-in subagents to alternate providers.

One hook, wired to four events, each with its own job:

* `PreToolUse` intercepts the Agent tool whenever `subagent_type` names a
  configured redirected subagent, and runs it elsewhere instead.
* `PostToolUse` opportunistically delivers finished background results, re-runs
  anything that was deferred, and clears out stale job state.
* `Stop` and `SubagentStop` wait for still-running background subagents at the
  end of a turn, then hand their results back.

Installed into the platform's `hooks/` directory from the Harness catalogue;
configuration lives in `harness-redirect-subagents/subagents.json` beside it,
runtime state alongside that -- see README.md.

Harness currently implements this hook only for Claude Code; ChatGPT also has a
built-in subagent tool, but redirect-subagents does not support it yet. Therefore
`--claude` is currently the only provider flag used when installing this hook.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rs_io import (  # noqa: E402
    JOBS_REL, build_cmd, clauder_available, defer_job, deferred_config,
    deliver_report, emit_json_output, is_deferrable, jobs_root, load_subagents,
    logger, open_job_ids, pop_deferred, prompt_input, root,
)

FOREGROUND_TIMEOUT_S = 540

WAIT_TIMEOUT_S = 540
POLL_INTERVAL_S = 2

# Job state past this age is deleted by any later hook run, in any session.
CLEANUP_AFTER_S = 24 * 3600

WAITING_MSG = (
    "One or more background subagents redirected away from your Claude "
    "subscription are still running. Waiting for them to finish before "
    "stopping (timeout {timeout}s)..."
)

EXPLAIN = (
    "This is intentional, not an error. If you need to start another subagent later, "
    "do so normally—the same redirection will be applied automatically. "
)


def deny(reason: str) -> None:
    logger.debug("Denying tool use with reason: %.100s...", reason)
    emit_json_output({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    sys.exit(0)


def block(reason: str) -> None:
    logger.debug("Delivering via block: %.100s...", reason)
    emit_json_output({"decision": "block", "reason": reason})
    sys.exit(0)


# PreToolUse: intercept the Agent tool

def run_subagent(agent: str, prompt: str, timeout: float | None = None) -> tuple[bool, str]:
    """Run a subagent synchronously through its configured backend.

    The backend runs in the config file's own directory: the project for
    entries from `.claude/harness-redirect-subagents/subagents.json`, the
    user's home for user-level entries.
    """
    cfg = load_subagents().get(agent)
    if not cfg:
        return False, f"No config for subagent '{agent}'"
    cmd = build_cmd(cfg, prompt, agent)
    logger.info("Running subagent %s: %s", agent, cmd)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, cwd=cfg.get("_cwd") or None,
            input=prompt_input(cfg, prompt),
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
        return False, result.stderr.strip() or result.stdout.strip()
    except subprocess.TimeoutExpired:
        return False, f"Subagent {agent} timed out after {timeout}s"
    except Exception as e:
        return False, f"Subagent {agent} failed: {e}"


def start_background_job(agent: str, cmd: list[str], session_id: str | None,
                         cwd: str | None = None,
                         stdin_text: str | None = None) -> str:
    """Launch cmd detached in background, return job ID."""
    job_id = uuid.uuid4().hex[:12]
    job_dir = root() / JOBS_REL / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Starting background job %s for agent %s", job_id, agent)
    logger.debug("Command: %s", cmd)

    # A plain `Popen(cmd, stdout=open(...))` launcher would do the same thing,
    # but the open-file handles it hands to the child keep the parent process
    # (and therefore this hook) attached to the pipes on Windows; a detached
    # launcher subprocess that owns the files lets this hook exit immediately.
    launcher_script = """
import sys, json, subprocess

try:
    config = json.loads(sys.stdin.read())
    with open(config['stdout'], 'w', encoding='utf-8') as out, \\
         open(config['stderr'], 'w', encoding='utf-8') as err:
        if config.get('stdin') is None:
            p = subprocess.Popen(config['cmd'], stdout=out, stderr=err,
                                 stdin=subprocess.DEVNULL, cwd=config.get('cwd'))
            code = p.wait()
        else:
            p = subprocess.Popen(config['cmd'], stdout=out, stderr=err,
                                 stdin=subprocess.PIPE, cwd=config.get('cwd'))
            p.communicate(config['stdin'].encode('utf-8'))
            code = p.returncode
    with open(config['exit_code'], 'w', encoding='utf-8') as f:
        f.write(str(code))
except Exception as e:
    if 'config' in locals() and 'stderr' in config:
        with open(config['stderr'], 'a', encoding='utf-8') as err:
            err.write(str(e))
finally:
    if 'config' in locals() and 'done' in config:
        open(config['done'], 'w').close()
"""

    if os.name == "nt":
        proc = subprocess.Popen(
            [sys.executable, "-c", launcher_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000,
        )
    else:
        proc = subprocess.Popen(
            [sys.executable, "-c", launcher_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    config_payload = {
        "cmd": cmd,
        "cwd": cwd,
        "stdin": stdin_text,
        "stdout": str(job_dir / "stdout.log"),
        "stderr": str(job_dir / "stderr.log"),
        "exit_code": str(job_dir / "exit_code"),
        "done": str(job_dir / "done"),
    }
    if proc.stdin:
        proc.stdin.write(json.dumps(config_payload).encode("utf-8"))
        proc.stdin.close()
    logger.debug("Launched detached process, PID: %s", proc.pid)

    (job_dir / "meta.json").write_text(json.dumps({
        "job_id": job_id,
        "session_id": session_id,
        "agent": agent,
        "pid": proc.pid,
        "started_at": time.time(),
        "finished_at": None,
        "delivered": False,
        "cmd": cmd,
    }), encoding="utf-8")
    return job_id


def pre_tool_use(payload: dict) -> None:
    logger.debug("deny-agent hook triggered")
    tool_input = payload.get("tool_input", {}) or {}
    session_id = payload.get("session_id")
    subagent_type = tool_input.get("subagent_type")
    if not isinstance(subagent_type, str) or not subagent_type:
        sys.exit(0)

    cfg = load_subagents().get(subagent_type)
    if not cfg or cfg.get("disabled", False):
        # Before letting an unknown/disabled subagent through to Claude Code,
        # see if any background job already finished. Delivering the report
        # now saves a whole turn of Claude waiting for it.
        finished = open_job_ids(session_id, done=True)
        if finished:
            # The user asked for a subagent that is unredirected, but we have
            # completed work from an earlier redirected one. That result is
            # worth more than this tool call: deny so the report lands now.
            # (Inside a subagent, this session's jobs belong to the main
            # conversation's own hooks, not to a delegate's context.)
            deny(deliver_report(finished))
        logger.debug("Allowing standard Agent tool. Subagent '%s' unknown or disabled.", subagent_type)
        sys.exit(0)

    prompt = tool_input.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        logger.debug("No prompt provided, passing through.")
        sys.exit(0)

    run_in_background = tool_input.get("run_in_background", True)
    run_in_background = (run_in_background is True) or (run_in_background == "true")

    logger.info("Intercepted Agent call. Type: %s, Background: %s", subagent_type, run_in_background)

    if is_deferrable(cfg) and not clauder_available():
        job_id = defer_job(subagent_type, prompt, session_id)
        if job_id is not None:
            deny(
                f"The {subagent_type} subagent is disabled in this session to avoid consuming Claude "
                "subscription usage, and the usual alternate provider (clauder) is not installed, so "
                f"the subagent has been deferred for the next turn (job {job_id}). On the next turn, "
                "re-run the exact same Agent tool call with the exact same prompt so it can be "
                "redirected to a fallback provider. This is intentional, not an error."
            )
            return

    if run_in_background:
        job_id_str = start_background_job(
            subagent_type,
            build_cmd(cfg, prompt, subagent_type),
            session_id,
            cwd=cfg.get("_cwd"),
            stdin_text=prompt_input(cfg, prompt),
        )
        logger.info("Started background subagent %s", job_id_str)
        deny(
            f"The {subagent_type} subagent is disabled in this session to avoid consuming Claude "
            f"subscription usage. Instead, it has been started in the background (subagent {job_id_str}) "
            "using a different Claude provider. You will be notified automatically when it finishes "
            "via a PreToolUse or PostToolUse hook. Do NOT sleep, poll, proactively check its progress, "
            "or run any command yourself to do so. Continue with other work or respond to the user "
            "instead.\n" + EXPLAIN
        )
        return

    logger.info("Running subagent %s in foreground.", subagent_type)
    ok, result = run_subagent(subagent_type, prompt, timeout=FOREGROUND_TIMEOUT_S)
    if ok:
        logger.info("Foreground run successful.")
        deny(
            f"The {subagent_type} subagent is disabled in this session to avoid consuming Claude "
            "subscription usage. Instead, it was run using a different Claude provider. "
            + EXPLAIN
            + "Its final report is below:\n\n"
            f"[{subagent_type} agent result]\n{result}"
        )
    else:
        logger.error("Foreground run failed.")
        deny(
            f"The {subagent_type} agent runner failed instead of returning normally. "
            f"Surface this to the user as-is, don't retry or work around it:\n\n{result}"
        )


# PostToolUse: deliver finished work, re-run deferred work, tidy up
#
# This runs once per tool call, so it also cleans up this tool's own leftovers:
# after a session with redirected background jobs ends, its job state would sit
# on disk forever otherwise. Anything past a day old is removed here instead.

def cleanup(max_age_s: int = CLEANUP_AFTER_S) -> None:
    """Delete every job directory past `max_age_s`.

    Deleting rather than archiving: everything a finished job ever produced
    has already been handed to the agent by the time its directory qualifies,
    and a job still running after a day is abandoned, so the only thing kept
    around either way would be logs nobody reads.
    """
    d = jobs_root()
    if not d.is_dir():
        return
    cutoff = time.time() - max_age_s
    for meta_path in list(d.glob("*/meta.json")) + list(d.glob("defer-*.json")):
        try:
            if meta_path.stat().st_mtime < cutoff:
                _remove(meta_path)
        except OSError:
            pass
    # The anchored root file and the jobs dir itself go once nothing is left.
    try:
        anchor = d / "root"
        if d.is_dir() and anchor.is_file() and not any(p.name != "root" for p in d.iterdir()):
            anchor.unlink()
            d.rmdir()
    except OSError:
        pass


def _remove(path: Path) -> None:
    try:
        if path.name == "meta.json":
            shutil.rmtree(path.parent)
        else:
            path.unlink()
    except OSError:
        pass


def post_tool_use(payload: dict) -> None:
    logger.debug("post-tool-use hook triggered")
    session_id = payload.get("session_id")

    if payload.get("agent_id"):
        # Inside a subagent's tool call: this session's jobs and deferred
        # work belong to the main conversation — a delegate's context is not
        # where a runaway `claude -p` re-run should land.
        sys.exit(0)

    cleanup()

    # A deferred job says clauder wasn't installed when the agent asked for
    # this subagent; re-run it through `claude -p` now that a new turn is
    # available, regardless of which tool call just finished.
    deferred = pop_deferred(session_id)
    if deferred is not None:
        cfg = deferred_config(deferred.get("agent", ""))
        if cfg is not None:
            _rerun_deferred(deferred, cfg)
        else:
            logger.warning(
                "Deferred subagent %s dropped: no runnable config for '%s'",
                deferred.get("job_id"), deferred.get("agent"),
            )

    finished = open_job_ids(session_id, done=True)
    if finished:
        block(deliver_report(finished))
        return

    running = open_job_ids(session_id, done=False)
    if running:
        logger.debug("%d subagent(s) still running: %s", len(running), running)
    sys.exit(0)


def _rerun_deferred(deferred: dict, cfg: dict) -> None:
    """Kick a deferred job off again through its fallback command, foreground.

    The fallback is `claude -p --agent <name>`, which reads the prompt from
    stdin — the config entry sets `_append_prompt: False`, so build_cmd strips
    `{prompt}` from the template and the prompt goes to the process's stdin
    instead of its command line (out of `ps` output and the process table).
    """
    prompt = deferred.get("prompt", "")
    agent = deferred.get("agent", "")
    cmd = build_cmd(cfg, prompt, agent)
    logger.info("Re-running deferred job %s: %s", deferred.get("job_id"), cmd)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=540, cwd=cfg.get("_cwd") or None,
            input=prompt,
        )
        text = result.stdout.strip() if result.returncode == 0 else (
            result.stderr.strip() or result.stdout.strip()
        )
    except Exception as e:
        text = f"deferred subagent failed: {e}"
    agent = deferred.get("agent", "?")
    block(
        f"This {agent} subagent was deferred earlier because clauder was not installed; "
        f"it has now been run through the fallback provider `{cmd[0]}` instead. "
        "Its report is below:\n\n"
        f"[{agent} agent result]\n{text}"
    )


# Stop/SubagentStop: wait for what is still running
#
# Claude Code runs every matching Stop hook in parallel, so this one waits
# alongside whatever else is wired to the event rather than sequencing itself
# in front of it.
#
# On a timeout the turn is allowed to end *without* blocking: the jobs keep
# running and the next turn's PreToolUse/PostToolUse hook delivers them.
# Blocking again would re-fire this hook after Claude's next message with the
# same jobs still running, and Claude Code overrides a Stop hook after 8
# consecutive blocks anyway.

def stop(payload: dict) -> None:
    logger.debug("stop-wait hook triggered")
    session_id = payload.get("session_id")

    if payload.get("agent_id"):
        # Inside a subagent (SubagentStop or a frontmatter Stop): the main
        # session's jobs belong to the main session's own Stop hook. Waiting
        # here would hold this subagent hostage to work it didn't start.
        sys.exit(0)

    outcome = _wait(session_id)
    if outcome is not None:
        block(outcome)
        return
    sys.exit(0)


def _wait(session_id: str | None) -> str | None:
    """The wait itself: a report to deliver, or None to let the stop proceed."""
    if report := deliver_report(open_job_ids(session_id, done=True)):
        return report

    running = open_job_ids(session_id, done=False)
    if not running:
        logger.debug("No running subagents for this session. Allowing Stop.")
        return None

    print(WAITING_MSG.format(timeout=WAIT_TIMEOUT_S), file=sys.stderr)

    logger.info("Waiting on %d running subagents: %s", len(running), running)
    deadline = time.monotonic() + WAIT_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_S)
        if report := deliver_report(open_job_ids(session_id, done=True)):
            return report
        if not open_job_ids(session_id, done=False):
            # Nothing left to wait for: the jobs finished and something else
            # — a sibling Stop hook running in parallel, or the PostToolUse
            # hook mid-turn — already claimed their reports. Polling on to
            # the deadline would stall the turn for nine minutes over work
            # that is done and delivered.
            logger.debug("Running subagents finished and were delivered elsewhere.")
            return None

    # Letting the stop proceed without a report: the jobs keep running, and
    # the next turn's PreToolUse/PostToolUse hook picks them up when they
    # finish. Blocking here instead would re-fire this hook after Claude's
    # next message with the same jobs still running — eight blocks in a row
    # and Claude Code forces the stop anyway, report undelivered.
    logger.warning("Timed out waiting for %d subagent(s): %s", len(running), running)
    return None


# entry point

HANDLERS = {
    "PreToolUse": pre_tool_use,
    "PostToolUse": post_tool_use,
    "Stop": stop,
    "SubagentStop": stop,
}


def hook_input() -> dict:
    try:
        stdin_text = sys.stdin.buffer.read().decode("utf-8")
    except AttributeError:  # tests swap in StringIO
        stdin_text = sys.stdin.read()
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
    except json.JSONDecodeError as e:
        logger.error("JSON decode error: %s", e)
        sys.exit(0)
    return payload if isinstance(payload, dict) else {}


def main() -> None:
    payload = hook_input()
    handler = HANDLERS.get(str(payload.get("hook_event_name") or ""))
    if handler is None:
        sys.exit(0)
    handler(payload)


if __name__ == "__main__":
    main()
