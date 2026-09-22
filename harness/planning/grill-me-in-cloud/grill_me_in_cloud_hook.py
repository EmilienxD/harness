"""Provider hook for the hosted Grill-Me board."""
from __future__ import annotations

import json
import os
import re
import signal
import sys
from pathlib import Path

from grill_cloud_core import HostedError, Interview, InterviewRuntime, RoundError


def context(event: str, text: str) -> dict:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def instructions(interview: Interview) -> str:
    return (
        "Publish the next grill round by writing its complete JSON directly to this reserved path:\n"
        f"{interview.source}\n"
        "The directory is outside the project. Do not inspect it or create another filename. "
        f"Write supporting images first under {interview.assets} and reference them with the URL prefix "
        f"{interview.assets_url}. Write the JSON last; that write triggers hosted publication."
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


def handle(payload: dict, provider: str, runtime: InterviewRuntime | None = None) -> dict | None:
    session = payload.get("session_id")
    event = payload.get("hook_event_name")
    if not isinstance(session, str) or not session or event not in {"UserPromptSubmit", "PostToolUse"}:
        return None
    project = Path(payload.get("cwd") or Path.cwd())
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
        return context(event, f"Hosted grill is not configured: {runtime.configuration_error}") if grilling else None
    try:
        recovered = ""
        try:
            retried = runtime.retry_pending(provider, session)
            if retried:
                latest = retried[-1]
                recovered = f"Recovered publication completed: round {latest['round_number']} — {latest['url']}\n\n"
        except (HostedError, OSError, ValueError) as error:
            # A stalled outbox must not block this session's fresh inbox or a new publication.
            recovered = f"A staged round is still waiting in the Harness outbox ({error}); it retries on a later grill hook event.\n\n"
        project = Path(payload.get("cwd") or Path.cwd())
        if (event == "UserPromptSubmit" and invocation) or skill_loaded:
            return context(event, recovered + instructions(runtime.start(provider, session, project)))
        if event == "UserPromptSubmit":
            interview = runtime.recover(provider, session, project)
            return context(event, recovered + instructions(interview)) if interview else (context(event, recovered.rstrip()) if recovered else None)
        published = runtime.publish(
            provider,
            session,
            session_title(payload, provider) or session,
            project=project,
        )
        if published is None:
            return None
        interview = runtime.current(provider, session)
        return context(
            event,
            f"Round {published['round_number']} was published: {published['url']}\n"
            "Publication is complete and does not wait for answers. End this turn normally; the next user message may contain the reviewed prompt.\n\n"
            f"A fresh path is reserved for a later round.\n{instructions(interview)}",
        )
    except RoundError as error:
        interview = runtime.current(provider, session)
        return context(event, f"Round validation failed: {error}\nWrite a complete corrected payload at the fresh path.\n\n{instructions(interview)}")
    except (HostedError, OSError, ValueError) as error:
        return context(event, f"Round publication failed: {error}. The material is retained in the durable Harness outbox and will retry on a later grill hook event. Do not claim that the round is available.")


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
