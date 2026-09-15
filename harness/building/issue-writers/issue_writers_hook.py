#!/usr/bin/env python3
"""Draft, cache, and publish GitHub issues without a model call.

One hook for the whole tool. The installer passes `--claude` or `--chatgpt`,
which picks the section that knows how that product identifies a session and
what it does between turns:

* Claude Code also wires the lifecycle events, so the final assistant message
  of every turn is cached and `/copy-message-as-issue` can publish it verbatim.
* ChatGPT exposes no equivalent, and its thread ids are not UUIDs, so they are
  mapped onto the UUID form that draft references use.

Publishing, drafting context, and the issue gateway itself all live in
``issues_core``.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import issues_core as core


CLAUDE = "claude"
CHATGPT = "chatgpt"

COPY_PATTERN = re.compile(r"^/copy-message-as-issue(?:\s|$)")
PUBLISH_PATTERN = re.compile(r"(?<![\w-])[$@/]publish-issues?(?=\s|$)")


def provider_from_argv(argv: list[str]) -> str:
    """The provider the installer wired this hook into."""
    for token in argv:
        if token == "--" + CHATGPT:
            return CHATGPT
        if token == "--" + CLAUDE:
            return CLAUDE
    return CLAUDE


def additional_context(text: str) -> None:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": text,
            }
        },
        sys.stdout,
    )


# Claude Code: cache the turn's final message so it can be copied as an issue

def cache_path(payload: dict) -> Path:
    session_id = payload.get("session_id", "")
    if not isinstance(session_id, str) or not core.SESSION_ID_PATTERN.fullmatch(session_id):
        raise ValueError("missing or invalid session ID")
    return Path(payload.get("cwd") or ".") / core.GATEWAY_DIR / ".responses" / f"{session_id}.json"


def invalidate(payload: dict) -> None:
    """A new turn must never publish a stale response if it fails or is interrupted."""
    cache_path(payload).unlink(missing_ok=True)


def capture(payload: dict) -> None:
    if payload.get("agent_id"):
        return
    path = cache_path(payload)
    body = payload.get("last_assistant_message")
    if not isinstance(body, str) or not body.strip():
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    ignore = core.GATEWAY_DIR / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    previous = core._read_json_dict(path)
    # Stop can fire again when another hook requests continuation.
    if previous.get("body") == body:
        return
    core._write_json_dict(path, {"id": str(uuid.uuid4()), "body": body})


def session_title(transcript_path: str, session_id: str) -> str:
    """AI title records are internal, optional metadata; never infer one from prose."""
    title = ""
    try:
        with Path(transcript_path).open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") != "ai-title" or record.get("sessionId") != session_id:
                    continue
                value = record.get("aiTitle")
                if isinstance(value, str) and value.strip():
                    title = " ".join(value.split())
    except OSError:
        pass
    return title


def save(payload: dict) -> str:
    if payload.get("prompt", "").strip() != "/copy-message-as-issue":
        return "Usage: /copy-message-as-issue (no arguments)."
    path = cache_path(payload)
    if not path.exists():
        return "No completed response cached. Finish a Claude response after installing issue-writers, then run /copy-message-as-issue."
    with core.file_lock(path.with_suffix(".lock")) as acquired:
        if not acquired:
            return "This session is already saving a response; retry when it finishes."
        cached = core._read_json_dict(path)
        body, response_id = cached.get("body"), cached.get("id")
        if not isinstance(body, str) or not body.strip() or not isinstance(response_id, str):
            return "No valid completed response cached; finish another Claude response first."
        session_id = payload["session_id"]
        key = f"save-{session_id}/{response_id}"
        with core._locked_state(core.GATEWAY_DIR) as (state_path, state):
            if state_path is None:
                return "Issue state is busy; retry /copy-message-as-issue."
            published = state.get("published", {}).get(key)
            inflight = state.get("inflight", {}).get(key)
        if published and not inflight:
            return f"Already saved: {published['url']}"
        # Freeze the title on first publication, including after partial failures.
        if inflight:
            title = inflight["title"]
        else:
            title = f"Report {session_id}"
            generated = session_title(str(payload.get("transcript_path") or ""), session_id)
            if generated:
                title += f" — {generated}"
            title = title[:256]
        report: list[str] = []
        ok, record, error = core.publish_reserved_issue(
            key=key, title=title, body=body, labels=[], parent=None,
            gateway_dir=core.GATEWAY_DIR, report=report,
        )
        if not ok:
            report.append(f"Copy failed: {error}. Retry /copy-message-as-issue to recover.")
        elif not core.finish_inflight(key, core.GATEWAY_DIR):
            report.append(f"Saved: {record['url']}; retry to finish recording completion.")
        else:
            report.append(f"Saved: {record['url']}")
        return "\n".join(report)


def handle_save(payload: dict) -> None:
    token = core.GH_DEADLINE.set(time.monotonic() + 240)
    try:
        result = save(payload)
    except subprocess.TimeoutExpired:
        result = "GitHub operation timed out. Retry /copy-message-as-issue to recover any partial publication."
    except Exception as exc:
        result = f"Copy failed: {exc}. Retry /copy-message-as-issue; no model fallback was invoked."
    finally:
        core.GH_DEADLINE.reset(token)
    sys.stderr.write("\n\n" + result + "\n")
    raise SystemExit(2)


def claude_lifecycle(payload: dict) -> None:
    """Keep the response cache honest across Stop, StopFailure, and SessionStart."""
    if payload.get("agent_id"):
        return
    if payload.get("cwd"):
        os.chdir(payload["cwd"])
    try:
        if payload.get("hook_event_name") == "Stop":
            capture(payload)
        elif payload.get("hook_event_name") in ("SessionStart", "StopFailure"):
            invalidate(payload)
    except Exception as exc:
        # Cache maintenance must never request another model turn.
        sys.stderr.write(f"copy-message-as-issue response cache unavailable: {exc}\n")


def claude_prompt(payload: dict) -> None:
    prompt = payload.get("prompt", "").strip()
    cwd = Path(str(payload.get("cwd") or ".")).resolve()

    if COPY_PATTERN.match(prompt):
        try:
            if payload.get("cwd"):
                os.chdir(payload["cwd"])
        except OSError as exc:
            sys.stderr.write(f"Save failed: {exc}\n")
            raise SystemExit(2)
        handle_save(payload)

    if core.PROMPT_PATTERN.match(prompt):
        dry = "--dry" in prompt.split()
        session_id = str(payload.get("session_id") or "")
        result = core.publish_issues(dry, session_id)
        sys.stderr.write("\n\n" + result)
        raise SystemExit(2)

    try:
        invalidate(payload)
    except (OSError, ValueError):
        pass

    contexts: list[str] = []
    try:
        notice = core.flush_notice(cwd / core.GATEWAY_DIR)
    except Exception:  # noqa: BLE001 - never block a prompt over a notice
        notice = None

    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "unknown")
        try:
            contexts.append(core.prepare_drafting_context(cwd, session_id))
        except Exception as exc:  # Drafting cannot safely continue without it.
            sys.stderr.write(f"issues gateway setup failed: {exc}")
            raise SystemExit(2) from exc

    if contexts:
        additional_context("\n\n".join(contexts))


# ChatGPT: no lifecycle cache, and thread ids need mapping

def gateway_session_id(session_id: str) -> str:
    """Map ChatGPT thread ids to the UUID form used by draft references."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:chatgpt:{session_id}"))


def chatgpt_prompt(payload: dict) -> None:
    prompt = str(payload.get("prompt") or "").strip()
    cwd = Path(str(payload.get("cwd") or ".")).resolve()
    os.chdir(cwd)

    if PUBLISH_PATTERN.search(prompt):
        dry = "--dry" in prompt.split()
        session_id = str(payload.get("session_id") or "")
        result = core.publish_issues(dry, gateway_session_id(session_id))
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    contexts: list[str] = []
    try:
        notice = core.flush_notice()
    except Exception:  # noqa: BLE001 - damaged notices never block prompts
        notice = None
    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "unknown")
        try:
            contexts.append(
                core.prepare_drafting_context(cwd, gateway_session_id(session_id))
            )
        except Exception as exc:  # Drafting cannot safely continue without it.
            sys.stderr.write(f"issues gateway setup failed: {exc}")
            raise SystemExit(2) from exc

    if contexts:
        additional_context("\n\n".join(contexts))


# entry point

def main(argv: list[str] | None = None) -> None:
    provider = provider_from_argv(sys.argv[1:] if argv is None else argv)
    payload = json.load(sys.stdin)
    if provider == CHATGPT:
        chatgpt_prompt(payload)
        return
    if payload.get("hook_event_name") in ("Stop", "StopFailure", "SessionStart"):
        claude_lifecycle(payload)
        return
    claude_prompt(payload)


def entrypoint(argv: list[str] | None = None) -> None:
    provider = provider_from_argv(sys.argv[1:] if argv is None else argv)
    try:
        main(argv)
    except SystemExit:
        raise
    except Exception as exc:
        if provider == CHATGPT:
            # ChatGPT has no fallback skill: a crash must block, not pass through.
            sys.stderr.write(f"harness issues hook failed in ChatGPT: {exc}")
            raise SystemExit(2) from exc
        raise


if __name__ == "__main__":
    entrypoint()
