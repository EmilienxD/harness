"""Provider adapters: publish a newly written round and return its answers."""
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
    def run(self, mode, board):
        npx = shutil.which("npx")
        if not npx:
            raise RuntimeError("npx is required for the interview runtime")
        arguments = [npx, "-y", "--package", "lavish-axi@0.1.71", "--package", "@toon-format/toon@2.3.1",
                     "node", str(Path(__file__).with_name("lavish_bridge.cjs")), mode, str(board)]
        process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", start_new_session=os.name != "nt",
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            stdout, stderr = process.communicate(timeout=60 if mode == "open" else None)
        except BaseException:
            # Stop the attached poll when its hook is interrupted. Lavish owns
            # its separately managed server and review windows.
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
        if mode == "open" and output.get("session", {}).get("status") == "user-ended":
            raise RuntimeError("The user ended this review")
        return output

    def open(self, board):
        return self.run("open", board)

    def poll(self, board):
        return self.run("poll", board)


def context(event, text):
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def instructions(interview):
    return (
        "If another grill round is needed, create its JSON directly at this reserved fresh path:\n"
        f"{interview.source}\n"
        "Its parent exists outside the project. Create it directly without listing directories or reading a template. "
        f"Supporting assets: {interview.assets}; HTML URL prefix: {interview.assets_url}. "
        "Write assets first, then the round JSON. The write hook renders, opens Lavish, and returns submitted answers in this tool call."
    )


def feedback_context(feedback, feedback_file, interview):
    # Return user feedback, attachments, and fatal errors, without the CLI's
    # operational instructions or page-sized DOM snapshot.
    delivered = {key: feedback[key] for key in ("session", "prompts", "artifact_failures") if key in feedback}
    if len(json.dumps(delivered)) > 6000:
        text = f"The complete grill feedback is saved at {feedback_file}. Read that file entirely before settling any decision; this batch is too large to return safely through hook context."
    else:
        text = "Grill interview feedback:\n" + json.dumps(delivered, ensure_ascii=False)
    review = feedback.get("session", {})
    if review.get("status") in {"ended", "browser_disconnected", "user-ended"} or review.get("session_ended"):
        return text + "\nThe review ended or disconnected. Continue in chat; a new review requires an explicit skill invocation."
    if feedback.get("artifact_failures"):
        text += "\nRepair the explanation using a fresh round file; fatal rendering feedback is not an answer."
    else:
        text += "\nSettle only explicitly answered questions; retain every unanswered question."
    return text + "\n\n" + instructions(interview)


def handle(payload, provider, runtime=None, lavish=None):
    session = payload.get("session_id")
    if not isinstance(session, str) or not session or payload.get("hook_event_name") not in {"UserPromptSubmit", "PostToolUse"}:
        return None
    runtime = runtime or InterviewRuntime()
    with runtime.claim(provider, session) as acquired:
        return _handle(payload, provider, runtime, lavish) if acquired else None


def _handle(payload, provider, runtime, lavish):
    event = payload["hook_event_name"]
    session = payload["session_id"]
    lavish = lavish or LavishCLI()
    prompt = payload.get("prompt", "")
    invocation = bool(isinstance(prompt, str) and re.search(
        r"(?<!\S)" + ("/" if provider == "claude" else r"\$") + r"grill-me-in-lavish(?=\s|$)", prompt))
    tool_input = payload.get("tool_input", {})
    skill_loaded = event == "PostToolUse" and payload.get("tool_name") == "Skill" and isinstance(tool_input, dict) and tool_input.get("skill") == "grill-me-in-lavish"
    response = payload.get("tool_response")
    if event == "PostToolUse" and isinstance(response, dict) and (response.get("isError") or response.get("error")):
        return None
    try:
        if (event == "UserPromptSubmit" and invocation) or skill_loaded:
            interview = runtime.start(provider, session, Path(payload.get("cwd") or Path.cwd()))
            return context(event, instructions(interview))
        if event == "UserPromptSubmit":
            interview = runtime.interrupt(provider, session)
            return context(event, "Chat interrupted the previous round. If revising it, unsent answers must be queued again.\n" + instructions(interview)) if interview else None
        published = runtime.publish(provider, session, lavish)
        if published is None:
            return None
        feedback, feedback_file = published
        return context(event, feedback_context(feedback, feedback_file, runtime.current(provider, session)))
    except RoundError as error:
        return context(event, f"Round validation failed: {error}\n\n" + instructions(runtime.current(provider, session)))
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
        runtime.interrupt(provider, session)
        return context(event, f"Round publication failed: {error}. Report this in chat; retry only when requested.")


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
