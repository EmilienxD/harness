"""Provider adapters: allocate, publish, wait, and return interview feedback."""
from __future__ import annotations

import json
import os
import re
import signal
import shutil
import subprocess
import sys
from pathlib import Path

from grill_lavish_core import InterviewRuntime, RoundError


class LavishCLI:
    def run(self, mode, board, receipt=None):
        npx = shutil.which("npx")
        if not npx:
            raise RuntimeError("npx is required for the interview runtime")
        arguments = [npx, "-y", "--package", "lavish-axi@0.1.71", "--package", "@toon-format/toon@2.3.1",
                     "node", str(Path(__file__).with_name("lavish_bridge.cjs")), mode, str(board)]
        if mode == "poll":
            arguments.append(str(receipt or board.parent / "feedback-receipt.json"))
        process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", start_new_session=os.name != "nt",
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            stdout, stderr = process.communicate(timeout=60 if mode == "open" else None)
        except BaseException:
            # An interrupted hook must not leave an untracked poll consuming
            # future answers. Leave Lavish's separately managed server alone.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            process.wait()
            raise
        if process.returncode:
            raise RuntimeError(stderr.strip() or stdout.strip() or "Lavish command failed")
        output = json.loads(stdout)
        if output.get("session", {}).get("status") == "user-ended":
            raise RuntimeError("The user ended this review. Do not reopen it automatically.")
        return output

    def open(self, board):
        return self.run("open", board)

    def poll(self, board, receipt=None):
        return self.run("poll", board, receipt)

    def end(self, board):
        return self.run("end", board)


def context(event, text, provider):
    if event == "Stop" and provider == "chatgpt":
        return {"decision": "block", "reason": text}
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def instructions(interview):
    if interview.phase in {"waiting", "opening"}:
        return "The current grill round is still awaiting user submission. Finish your response to let the hook wait. Write the next round only after submitted feedback supplies its reserved path. Do not run Lavish commands."
    if interview.phase == "paused":
        return (
            "The grill review is paused. Discuss continuation in chat; do not reopen automatically. "
            "An explicit skill invocation starts a fresh review. "
            f'To cancel, create {{"cancel":true}} directly at this reserved fresh path: {interview.source}. '
            "Its parent exists; hooks will close any opened review without polling."
        )
    revision = "This revises an unsubmitted round. Tell the user that a separate review will open and unsent answers must be queued again.\n" if interview.replace_review else ""
    return revision + (
        f"Grill interview round {interview.round}. Create the complete JSON round directly at:\n"
        f"{interview.source}\n"
        "This exact path is reserved for you and does not exist. The runtime created its parent; "
        "create the file without listing directories or reading a template. You are the only writer of this inbox. "
        f"Your empty supporting-assets directory is {interview.assets}; use {interview.assets_url}<filename> paths in HTML. "
        "Write the round JSON last: its successful write automatically publishes the board. "
        "The write hook normally waits and returns submitted user feedback in this tool call. "
        "If feedback has not arrived through the write hook, finish your response so the Stop hook can recover waiting. Hooks handle opening and polling; "
        "do not invoke Lavish help/open/poll or edit the generated board. "
        'When every decision is settled, write {"complete":true,"summary":"Brief agreed solution"} '
        "to the supplied path before your final summary, and await the user's confirmation before implementation."
        ' If the user cancels or changes tasks, write {"cancel":true} to this path to disarm the interview.'
    )


def feedback_context(interview):
    feedback = interview.feedback or {}
    # Keep user-authored feedback, attachments, and fatal errors. The CLI's
    # generic operational next_step and page-sized DOM snapshot are unnecessary.
    delivered = {key: feedback[key] for key in ("session", "prompts", "artifact_failures") if key in feedback}
    if len(json.dumps(delivered)) > 6000:
        text = f"The complete grill feedback is saved at {interview.directory / 'feedback-latest.json'}. Read that file entirely before settling any decision; this batch is too large to return safely through hook context."
    else:
        text = "Grill interview feedback:\n" + json.dumps(delivered, ensure_ascii=False)
    if interview.phase == "paused":
        return text + "\n" + instructions(interview)
    if feedback.get("artifact_failures"):
        text += "\nRepair the explanation using a fresh round file; fatal rendering feedback is not an answer."
    else:
        text += "\nSettle only explicitly answered questions; retain every unanswered question."
    return text + "\n\n" + instructions(interview)


def handle(payload, provider, runtime=None, lavish=None):
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return None
    runtime = runtime or InterviewRuntime()
    with runtime.claim(provider, session) as acquired:
        return _handle(payload, provider, runtime, lavish) if acquired else None


def _handle(payload, provider, runtime, lavish):
    event = payload.get("hook_event_name")
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return None
    lavish = lavish or LavishCLI()
    prompt = payload.get("prompt", "")
    invocation = bool(isinstance(prompt, str) and re.search(
        r"(?<!\S)" + ("/" if provider == "claude" else r"\$") + r"grill-me-in-lavish(?=\s|$)", prompt))
    tool_input = payload.get("tool_input", {})
    skill_loaded = event == "PostToolUse" and payload.get("tool_name") == "Skill" and isinstance(tool_input, dict) and tool_input.get("skill") == "grill-me-in-lavish"
    activated = (event == "UserPromptSubmit" and invocation) or skill_loaded
    if event in {"Interrupt", "StopFailure", "SessionEnd"}:
        # Never interpret interruptions as completion or consume another batch.
        return None
    if event not in {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"}:
        return None
    response = payload.get("tool_response")
    if event == "PostToolUse" and isinstance(response, dict) and (response.get("isError") or response.get("error")):
        return None
    try:
        interview = runtime.current(provider, session)
        if activated:
            if interview is not None and interview.phase in {"paused", "closing"}:
                runtime.close(provider, session, lavish)
            interview = runtime.start(provider, session, Path(payload.get("cwd") or Path.cwd()))
        if interview is None or interview.phase == "complete":
            return None
        interview = runtime.publish(provider, session, lavish)
        if interview.phase == "opening":
            interview = runtime.open(provider, session, lavish)
        if event in {"SessionStart", "UserPromptSubmit"} or skill_loaded:
            # Recover staged content before advertising an inbox. Startup never
            # waits on the user; an existing receipt can be recovered locally.
            if interview.phase == "waiting" and interview.receipt.exists():
                interview = runtime.wait(provider, session, lavish)
            if event == "UserPromptSubmit" and not activated and interview.phase in {"opening", "waiting"}:
                interview.phase = "ready"
                interview.replace_review = True
                runtime.reserve_fresh(interview)
                runtime.save(provider, session, interview)
            if interview.phase == "complete":
                return None
            return context(event, feedback_context(interview) if interview.feedback else instructions(interview), provider)
        interview = runtime.wait(provider, session, lavish)
    except RoundError as error:
        interview = runtime.current(provider, session)
        return context(event, f"Round validation failed: {error}\n\n" + instructions(interview), provider)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
        # Stop must not turn transport errors into an endless continuation loop.
        interview = runtime.current(provider, session)
        if interview is not None:
            if interview.phase == "closing":
                message = f"Review cleanup is pending: {error}. Hooks will retry closing on later session activity; do not reopen or poll."
                return {"systemMessage": message} if event == "Stop" else context(event, message, provider)
            interview.phase = "paused"
            runtime.save(provider, session, interview)
        return context(event, f"Interview runtime could not continue: {error}. Report this in chat; do not automatically reopen or poll.", provider)
    if interview.feedback and not interview.notified:
        interview.notified = True
        runtime.save(provider, session, interview)
        return context(event, feedback_context(interview), provider)
    return None


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    provider = "chatgpt" if "--chatgpt" in sys.argv else "claude"
    try:
        output = handle(json.load(sys.stdin), provider)
        print(json.dumps(output or {}))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
