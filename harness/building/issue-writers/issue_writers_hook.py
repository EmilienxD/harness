#!/usr/bin/env python3
"""Draft, cache, and publish GitHub issues without a model call.

One hook for the whole tool. The installer passes `--claude` or `--chatgpt`,
which picks the section that knows how that product identifies a session and
what it does between turns:

* Both providers wire lifecycle events so the final assistant message can be
  published verbatim by ``copy-message-as-issue``.
* ChatGPT thread ids are mapped onto the UUID form that draft references use.

Publishing, drafting context, and the issue gateway itself all live in
``issues_core``.
"""
from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path

import copy_message_as_issue as copy_hook
import issues_core as core


CLAUDE = "claude"
CHATGPT = "chatgpt"

COPY_PATTERN = re.compile(r"(?<![\w-])[$@/]copy-message-as-issue(?=\s|$)")
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


def claude_lifecycle(payload: dict) -> None:
    """Keep the response cache honest across provider lifecycle events."""
    if payload.get("agent_id"):
        return
    if payload.get("cwd"):
        os.chdir(payload["cwd"])
    try:
        if payload.get("hook_event_name") == "Stop":
            copy_hook.capture(payload)
        elif payload.get("hook_event_name") in ("SessionStart", "SessionEnd", "StopFailure"):
            copy_hook.invalidate(payload)
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
        copy_hook.handle_save(payload)

    if core.PROMPT_PATTERN.match(prompt):
        session_id = str(payload.get("session_id") or "")
        result = core.run_publish_command(prompt, session_id)
        sys.stderr.write("\n\n" + result)
        raise SystemExit(2)

    try:
        copy_hook.invalidate(payload)
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


# ChatGPT lifecycle, prompt handling, and thread-id mapping

def gateway_session_id(session_id: str) -> str:
    """Map ChatGPT thread ids to the UUID form used by draft references."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:chatgpt:{session_id}"))


def chatgpt_prompt(payload: dict) -> None:
    prompt = str(payload.get("prompt") or "").strip()
    event = payload.get("hook_event_name")
    if event == "Stop":
        copy_hook.capture(payload)
        json.dump({}, sys.stdout)
        return
    if event in {"SessionStart", "SessionEnd", "Interrupt"}:
        copy_hook.invalidate(payload)
        return

    cwd = Path(str(payload.get("cwd") or ".")).resolve()
    os.chdir(cwd)

    if COPY_PATTERN.search(prompt):
        result = copy_hook.save(payload)
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    if PUBLISH_PATTERN.search(prompt):
        session_id = str(payload.get("session_id") or "")
        result = core.run_publish_command(prompt, gateway_session_id(session_id))
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    try:
        copy_hook.invalidate(payload)
    except (OSError, ValueError):
        pass

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
    if payload.get("hook_event_name") in ("Stop", "StopFailure", "SessionStart", "SessionEnd"):
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
