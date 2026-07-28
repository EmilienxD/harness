#!/usr/bin/env python3
"""
Claude Code UserPromptSubmit hook for `/commit <message>`.

Runs BEFORE the prompt is sent to the model. If the prompt matches
`/commit <message>`, this script stages + commits changes itself and
rejects the prompt with a status string, which Claude Code shows
directly to the user. The model is never called for this turn.

Any other prompt is let through untouched.
"""
import json
import re
import subprocess
import sys

COMMIT_PATTERN = re.compile(r"^/commit(?:\s+(.+))?$", re.DOTALL)


def get_changed_paths(transcript_path: str):
    """
    PLACEHOLDER.

    Eventually: parse the session transcript at `transcript_path` for
    Edit/Write/NotebookEdit tool_use entries from THIS session and
    return the list of file paths they touched, so we only stage what
    Claude actually changed (not unrelated dirty files in the repo).

    Returning None means "no session-derived list available yet" and
    tells the caller to fall back to staging everything.
    """
    # TODO: replace with real transcript parsing
    return None


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def finish(message: str, ok: bool):
    """
    Reject the prompt either way (success or failure) so it never reaches
    the model. `message` is what the user sees in place of a response.
    Exit code 2 is what makes Claude Code treat stderr as the rejection
    reason for a UserPromptSubmit hook.
    """
    sys.stderr.write(message if message.endswith("\n") else message + "\n")
    sys.exit(2 if True else 0)  # always 2: we always want to block this turn


def allow():
    """Let the prompt through unchanged; a normal model turn follows."""
    sys.exit(0)


def main():
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "")
    cwd = payload.get("cwd", ".")
    session_id = payload.get("session_id", "unknown")
    transcript_path = payload.get("transcript_path", "")

    match = COMMIT_PATTERN.match(prompt.strip())
    if not match:
        allow()
        return

    message = (match.group(1) or "").strip()
    if not message:
        finish("Usage: /commit <message>", ok=False)
        return

    changed = get_changed_paths(transcript_path)

    if changed:
        add_result = run(["git", "add", "--", *changed], cwd)
    else:
        # placeholder fallback until transcript parsing is implemented
        add_result = run(["git", "add", "-A"], cwd)

    if add_result.returncode != 0:
        finish(f"git add failed:\n{add_result.stderr}", ok=False)
        return

    status = run(["git", "status", "--porcelain"], cwd)
    if not status.stdout.strip():
        finish("Nothing to commit — working tree matches HEAD.", ok=False)
        return

    commit_result = run(
        ["git", "commit", "-m", message, "-m", f"Claude-session: {session_id}"],
        cwd,
    )

    if commit_result.returncode != 0:
        finish(f"git commit failed:\n{commit_result.stderr}", ok=False)
        return

    sha = run(["git", "rev-parse", "--short", "HEAD"], cwd).stdout.strip()
    finish(f"Committed {sha}: {message}", ok=True)


if __name__ == "__main__":
    main()