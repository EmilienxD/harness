#!/usr/bin/env python3
"""Draft and publish GitHub issues without a model call.

One hook for the whole tool. The installer passes `--claude` or `--chatgpt`,
which picks the section that knows how that product identifies a session and
what it does between turns:

* ChatGPT thread ids are mapped onto the UUID form that draft references use.

Publishing, drafting context, and the drafts directory itself all live in
``issues_core``.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import issues_core as core


CLAUDE = "claude"
CHATGPT = "chatgpt"

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


def claude_prompt(payload: dict) -> None:
    prompt = payload.get("prompt", "").strip()
    cwd = Path(str(payload.get("cwd") or ".")).resolve()

    session_id = str(payload.get("session_id") or "unknown")

    if core.PROMPT_PATTERN.search(prompt):
        result = core.run_publish_command(prompt, session_id, cwd)
        sys.stderr.write("\n\n" + result)
        raise SystemExit(2)

    contexts: list[str] = []
    try:
        notice = core.flush_notice(cwd, session_id)
    except Exception:  # noqa: BLE001 - never block a prompt over a notice
        notice = None

    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        try:
            contexts.append(core.prepare_drafting_context(cwd, session_id))
        except Exception as exc:  # Drafting cannot safely continue without it.
            sys.stderr.write(f"issue drafting setup failed: {exc}")
            raise SystemExit(2) from exc

    if contexts:
        additional_context("\n\n".join(contexts))


# ChatGPT prompt handling and thread-id mapping

def issues_session_id(session_id: str) -> str:
    """Map ChatGPT thread ids to the UUID form used by draft references."""
    return core.provider_session_id(CHATGPT, session_id)


def claude_session_start(payload: dict) -> None:
    """Persist hook-owned identity for subsequent Claude Bash commands."""
    env_file = os.environ.get("CLAUDE_ENV_FILE")
    if not env_file:
        return
    session_id = core.provider_session_id(CLAUDE, str(payload.get("session_id") or ""))
    # A validated UUID needs no shell quoting and cannot inject shell syntax.
    with Path(env_file).open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(f"\nexport {core.CLAUDE_SESSION_VARIABLE}={session_id}\n")


def chatgpt_prompt(payload: dict) -> None:
    prompt = str(payload.get("prompt") or "").strip()
    cwd = Path(str(payload.get("cwd") or ".")).resolve()
    os.chdir(cwd)
    session_id = issues_session_id(str(payload.get("session_id") or "unknown"))

    if core.PROMPT_PATTERN.search(prompt):
        result = core.run_publish_command(prompt, session_id, cwd)
        json.dump({"decision": "block", "reason": result}, sys.stdout)
        return

    contexts: list[str] = []
    try:
        notice = core.flush_notice(cwd, session_id)
    except Exception:  # noqa: BLE001 - damaged notices never block prompts
        notice = None
    if notice:
        contexts.append(notice)

    if core.DRAFT_PATTERN.search(prompt):
        try:
            contexts.append(core.prepare_drafting_context(cwd, session_id))
        except Exception as exc:  # Drafting cannot safely continue without it.
            reject(f"issue drafting setup failed: {exc}", CHATGPT)

    if contexts:
        additional_context("\n\n".join(contexts))


def reject(message: str, provider: str) -> None:
    if provider == CHATGPT:
        json.dump({"decision": "block", "reason": message}, sys.stdout)
        raise SystemExit(0)
    sys.stderr.write(message)
    raise SystemExit(2)


# entry point

def main(argv: list[str] | None = None) -> None:
    provider = provider_from_argv(sys.argv[1:] if argv is None else argv)
    reconfigure = getattr(sys.stdin, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="strict")
    payload = json.load(sys.stdin)
    if payload.get("hook_event_name") == "Stop":
        cwd = Path(str(payload.get("cwd") or ".")).resolve()
        session_id = core.provider_session_id(provider, str(payload.get("session_id") or ""))
        core.snapshot_drafts(cwd, session_id)
        json.dump({}, sys.stdout)
        return
    if provider == CLAUDE and payload.get("hook_event_name") == "SessionStart":
        claude_session_start(payload)
        return
    if provider == CHATGPT:
        chatgpt_prompt(payload)
        return
    claude_prompt(payload)


def entrypoint(argv: list[str] | None = None) -> None:
    provider = provider_from_argv(sys.argv[1:] if argv is None else argv)
    try:
        main(argv)
    except SystemExit:
        raise
    except Exception as exc:
        reject(f"harness issues hook failed ({type(exc).__name__}): {exc}", provider)


if __name__ == "__main__":
    entrypoint()
