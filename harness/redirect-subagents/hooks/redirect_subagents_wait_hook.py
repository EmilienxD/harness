#!/usr/bin/env python3
"""Stop/SubagentStop hook: waits for running background subagents at the end
of a turn, then hands their results back to the agent.

Claude Code runs every matching Stop hook in parallel, so this one waits
alongside whatever else you have wired to the event rather than sequencing
itself in front of it.

On a timeout the turn is allowed to end *without* blocking: the jobs keep
running and the next turn's PreToolUse/PostToolUse hook delivers them.
Blocking again would re-fire this hook after Claude's next message with the
same jobs still running, and Claude Code overrides a Stop hook after 8
consecutive blocks anyway.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rs_io import (  # noqa: E402
    deliver_report, emit_json_output, logger, open_job_ids,
)

WAIT_TIMEOUT_S = 540
POLL_INTERVAL_S = 2

WAITING_MSG = (
    "One or more background subagents redirected away from your Claude "
    "subscription are still running. Waiting for them to finish before "
    "stopping (timeout {timeout}s)..."
)


def block(reason: str) -> None:
    logger.debug("Blocking stop event. Reason: %.100s...", reason)
    emit_json_output({"decision": "block", "reason": reason})
    sys.exit(0)


def main() -> None:
    logger.debug("stop-wait hook triggered")

    try:
        stdin_text = sys.stdin.buffer.read().decode("utf-8")
    except AttributeError:  # tests swap in StringIO
        stdin_text = sys.stdin.read()
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
    except json.JSONDecodeError as e:
        logger.error("JSON decode error: %s", e)
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

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


if __name__ == "__main__":
    main()
