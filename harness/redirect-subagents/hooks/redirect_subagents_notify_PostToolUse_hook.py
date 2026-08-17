#!/usr/bin/env python3
"""PostToolUse hook: fires after tool calls to opportunistically deliver
finished background subagent results.

This hook runs once per tool call, so it also cleans up this tool's own
leftovers: after a session with redirected background jobs ends, its job state
under .claude/harness-redirect-subagents/ would sit on disk forever otherwise.
Anything past a day old is removed here instead.

Installed into .claude/hooks/ by `harness install redirect-subagents`.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rs_io import (  # noqa: E402
    build_cmd, deferred_config, deliver_report, emit_json_output, jobs_root,
    logger, open_job_ids, pop_deferred,
)

# Job state past this age is deleted by any later hook run, in any session.
CLEANUP_AFTER_S = 24 * 3600


def block(reason: str) -> None:
    logger.debug("Delivering via PostToolUse: %.100s...", reason)
    emit_json_output({"decision": "block", "reason": reason})
    sys.exit(0)


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
    import shutil

    try:
        if path.name == "meta.json":
            shutil.rmtree(path.parent)
        else:
            path.unlink()
    except OSError:
        pass


def main() -> None:
    logger.debug("post-tool-use hook triggered")
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        logger.error("JSON decode error: %s", e)
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

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

    The fallback is `claude -p`, which reads the prompt from stdin — the
    config entry sets `_append_prompt: False`, so build_cmd strips `{prompt}`
    from the template and the prompt goes to the process's stdin instead of
    its command line (out of `ps` output and the process table).
    """
    prompt = deferred.get("prompt", "")
    cmd = build_cmd(cfg, prompt)
    logger.info("Re-running deferred job %s: %s", deferred.get("job_id"), cmd)
    try:
        import subprocess

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


if __name__ == "__main__":
    main()
