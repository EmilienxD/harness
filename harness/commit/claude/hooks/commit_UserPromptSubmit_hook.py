#!/usr/bin/env python3
"""Claude Code UserPromptSubmit adapter for the shared commit implementation."""
from __future__ import annotations

import json
import os
import sys

import commit_core as core


def main() -> None:
    core._force_utf8_output()
    if len(sys.argv) > 1:
        core.cli_main(sys.argv[1:])
        return

    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "")
    cwd = payload.get("cwd", ".")
    session_id = payload.get("session_id", "unknown")
    transcript_path = payload.get("transcript_path", "")

    match = core.COMMIT_PATTERN.match(prompt.strip())
    if not match:
        core.allow()
        return

    flags, message = core.split_flags(match.group(1) or "")
    if not message and not flags.use_ai and not flags.dry:
        core.finish(
            "Usage: /commit [--dry] [--ai] <message>\n"
            "  --ai      generate the message from the staged diff "
            "(makes <message> optional)\n"
            "            any text after --ai becomes steering guidance\n"
            "  --dry show what would happen, change nothing"
        )
        return

    toplevel = core.run(["git", "rev-parse", "--show-toplevel"], cwd)
    if toplevel.returncode != 0:
        core.finish("Not a git repository -- nothing to commit.")
        return
    repo_root = os.path.normpath(toplevel.stdout.strip()) or cwd

    scan = core._scan_writes(transcript_path, repo_root)
    if flags.dry:
        core.finish(
            core.build_dry_run_report(
                message, session_id, transcript_path, repo_root, scan, flags
            )
        )
        return

    changed = core.changed_paths(scan)
    widened = ""
    if changed:
        add_result, targets = core.stage_paths(changed, repo_root)
        if add_result is None:
            core.finish(
                "Claude edited files this session, but none of them still "
                "exist or are tracked -- nothing to stage."
            )
            return
    else:
        add_result, targets = core.run(["git", "add", "-A"], repo_root), []
        if scan is not None and scan.unresolved:
            widened = (
                f"; staged the whole tree -- {len(scan.unresolved)} shell "
                "write(s) with an unreadable target"
            )

    if add_result.returncode != 0:
        core.finish(f"git add failed:\n{add_result.stderr}")
        return

    scope = ["--", *targets] if targets and not core.in_merge(repo_root) else []
    staged = core.run(["git", "diff", "--cached", "--name-only", *scope], repo_root)
    if not staged.stdout.strip():
        core.finish("Nothing to commit -- working tree matches HEAD.")
        return

    body = ""
    if flags.use_ai:
        try:
            ai = core.generate_commit_message(
                repo_root, targets if scope else [], True, transcript_path, message
            )
        except core.AiError as exc:
            core.finish(
                f"{exc}\n\n"
                f"{len(staged.stdout.strip().splitlines())} file(s) are still staged -- "
                "nothing was committed.\nRerun with an explicit message: /commit <message>"
            )
            return
        message, body = ai.subject, ai.body

    commit_args = ["git", "commit", "-m", message]
    if body:
        commit_args += ["-m", body]
    commit_args += ["-m", f"Claude-session: {session_id}", *scope]
    commit_result = core.run(commit_args, repo_root)
    if commit_result.returncode != 0:
        core.finish(f"git commit failed:\n{commit_result.stderr}")
        return

    sha = core.run(["git", "rev-parse", "--short", "HEAD"], repo_root).stdout.strip()
    count = len(staged.stdout.strip().splitlines())
    held_back = len(core.staged_elsewhere(targets, repo_root)) if scope else 0
    suffix = f", {held_back} left staged" if held_back else ""
    core.finish(f"Committed {sha} ({count} file(s){suffix}){widened}: {message}")


def entrypoint() -> None:
    core.guarded_main("Claude Code", main)


if __name__ == "__main__":
    entrypoint()
