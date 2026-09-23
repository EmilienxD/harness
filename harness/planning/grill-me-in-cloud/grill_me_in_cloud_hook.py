"""Provider hook for the hosted Grill-Me board."""
from __future__ import annotations

import json
import os
import re
import signal
import sys
from pathlib import Path

from grill_cloud_core import HostedError, Interview, InterviewRuntime, RoundError


STOP = "Tell the user in one line and stop."


def context(event: str, text: str) -> dict:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def instructions(interview: Interview) -> str:
    return (
        "Publish the next grill round by writing its complete JSON directly to this reserved path:\n"
        f"{interview.source}\n"
        f"Write supporting images first under {interview.assets} and reference them with the URL prefix "
        f"{interview.assets_url}.\n"
        "The system owns and creates both directories and their parents outside the project. They are reserved "
        "to your session and you are their sole writer; create the files directly at these exact paths without "
        "listing the directories or reading a template. Write the round file last: a successful write publishes "
        "it automatically."
    )


def _last_jsonl_value(path: Path, match: str, key: str, value: str) -> str:
    """Return the latest non-empty string under `key` in records whose `match` field equals `value`."""
    title = ""
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if value not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and record.get(match) == value:
                    found = record.get(key)
                    if isinstance(found, str) and found.strip():
                        title = " ".join(found.split())
    except OSError:
        pass
    return title


def session_title(payload: dict, provider: str) -> str:
    """Read the provider's generated session name; empty when it has not produced one yet."""
    session = payload["session_id"]
    if provider == "chatgpt":
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        return _last_jsonl_value(home / "session_index.jsonl", "id", "thread_name", session)
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return ""
    return _last_jsonl_value(Path(transcript), "sessionId", "aiTitle", session)


def project_root(payload: dict) -> Path:
    """The project where the session started; the payload cwd follows the agent's `cd` into subdirectories."""
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or Path.cwd())


def handle(payload: dict, provider: str, runtime: InterviewRuntime | None = None) -> dict | None:
    session = payload.get("session_id")
    event = payload.get("hook_event_name")
    if not isinstance(session, str) or not session or event not in {"UserPromptSubmit", "PostToolUse"}:
        return None
    project = project_root(payload)
    runtime = runtime or InterviewRuntime.from_environment(project=project)
    with runtime.claim(provider, session) as acquired:
        return _handle(payload, provider, runtime) if acquired else None


def _handle(payload: dict, provider: str, runtime: InterviewRuntime) -> dict | None:
    event = payload["hook_event_name"]
    session = payload["session_id"]
    prompt = payload.get("prompt", "")
    invocation = bool(isinstance(prompt, str) and re.search(
        r"(?<!\S)" + ("/" if provider == "claude" else r"\$") + r"grill-me-in-cloud(?=\s|$)", prompt))
    tool_input = payload.get("tool_input", {})
    skill_loaded = (
        event == "PostToolUse" and payload.get("tool_name") == "Skill" and
        isinstance(tool_input, dict) and tool_input.get("skill") == "grill-me-in-cloud"
    )
    response = payload.get("tool_response")
    if event == "PostToolUse" and isinstance(response, dict) and (response.get("isError") or response.get("error")):
        return None
    grilling = invocation or skill_loaded or runtime.current(provider, session) is not None
    if runtime.configuration_error is not None:
        return context(event, f"Hosted grill is not configured: {runtime.configuration_error}. {STOP}") if grilling else None
    project = project_root(payload)
    if event == "UserPromptSubmit" or skill_loaded:
        return _prepare(event, provider, session, project, runtime, invocation or skill_loaded, grilling)
    return _publish(payload, provider, session, project, runtime)


def _retry_queued(runtime: InterviewRuntime, provider: str, session: str) -> tuple[str, bool]:
    """Report a round an outage left queued; the flag is set when the interview cannot continue."""
    try:
        published = runtime.retry_pending(provider, session)
    except HostedError as error:
        if not error.retryable:
            return f"The queued round cannot be published: {error}. {STOP}", True
        return f"The queued round is still unpublished ({error}); it retries on the next user message.\n\n", False
    if not published:
        return "", False
    latest = published[-1]
    return f"Queued round {latest['round_number']} is now published: {latest['url']}\n\n", False


def _prepare(
    event: str, provider: str, session: str, project: Path, runtime: InterviewRuntime, starting: bool, grilling: bool,
) -> dict | None:
    """Queued rounds retry only here, so ordinary tool calls never wait on the board."""
    try:
        queued, stopped = _retry_queued(runtime, provider, session)
        if stopped:
            return context(event, queued)
        interview = runtime.start(provider, session, project) if starting else runtime.recover(provider, session, project)
    except (HostedError, OSError, ValueError) as error:
        # Every prompt looks up a hosted session, so an outage stays silent outside grill sessions.
        return context(event, f"Grill setup failed: {error}. {STOP}") if grilling else None
    if interview is None:
        return context(event, queued.rstrip()) if queued else None
    return context(event, queued + instructions(interview))


def _publish(payload: dict, provider: str, session: str, project: Path, runtime: InterviewRuntime) -> dict | None:
    event = payload["hook_event_name"]
    try:
        published = runtime.publish(provider, session, session_title(payload, provider) or session, project=project)
    except RoundError as error:
        return context(
            event,
            f"Round rejected: {error}\nFix it and write the complete round, images included, to the new paths below.\n\n"
            f"{instructions(runtime.current(provider, session))}",
        )
    except HostedError as error:
        if error.retryable:
            return context(event, f"Round not published yet: {error}. It is queued and retries on the user's next message. {STOP}")
        return context(event, f"Round cannot be published: {error}. {STOP}")
    except (OSError, ValueError) as error:
        return context(event, f"Round cannot be published: {error}. {STOP}")
    if published is None:
        return None
    return context(
        event,
        f"Round {published['round_number']} was published: {published['url']}\n"
        "Only reply \"Round available at: <URL>\", replacing `<URL>` with the round's URL, then end your turn; the user's answer will be automatically routed to you as the next user message.\n\n"
        f"A fresh path is reserved for a later round.\n{instructions(runtime.current(provider, session))}",
    )


def main() -> int:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    provider = "chatgpt" if "--chatgpt" in sys.argv else "claude"
    try:
        print(json.dumps(handle(json.load(sys.stdin), provider) or {}))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
