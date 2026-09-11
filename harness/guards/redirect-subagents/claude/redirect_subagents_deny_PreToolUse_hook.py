#!/usr/bin/env python3
"""PreToolUse hook: intercepts the Agent tool whenever subagent_type is a
configured redirected subagent.

Installed into .claude/hooks/ from the Harness catalogue;
configuration lives in .claude/harness-redirect-subagents/subagents.json,
runtime state alongside it — see README.md.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rs_io import (  # noqa: E402
    JOBS_REL, build_cmd, clauder_available, defer_job, deliver_report,
    emit_json_output, is_deferrable, load_subagents, logger, open_job_ids,
    prompt_input, root,
)

FOREGROUND_TIMEOUT_S = 540


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


EXPLAIN = (
    "This is intentional, not an error. If you need to start another subagent later, "
    "do so normally—the same redirection will be applied automatically. "
)


def main() -> None:
    logger.debug("deny-agent hook triggered")
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        logger.error("JSON decode error: %s", e)
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
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


if __name__ == "__main__":
    main()
