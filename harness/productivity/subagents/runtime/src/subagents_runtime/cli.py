"""Persistent session commands for the subagents bundle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from subagents_runtime import __version__
from subagents_runtime.delegation import arm_reply, process_inbox
from subagents_runtime.sessions import SessionError, launch, launch_delegated, resume
from subagents_runtime.progress import choose_current_session, watch


def cmd_run(args: argparse.Namespace) -> int:
    session_id = launch(" ".join(args.prompt).strip() or None, provider=args.provider)
    print(f"Started visible session {session_id}")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    results = process_inbox(args.session_id, launch=launch_delegated)
    launched = sum(result.status == "launched" for result in results)
    failed = sum(result.status == "failed" for result in results)
    uncertain = sum(result.status == "uncertain" for result in results)
    print(
        f"Processed {len(results)} requests: {launched} launched, {failed} failed, {uncertain} uncertain"
    )
    for result in results:
        agent = ""
        if result.child_session_id and result.status == "launched":
            from subagents_runtime.storage import connect

            with connect() as db:
                row = db.execute("SELECT agent_index,execution_mode FROM sessions WHERE id=?", (result.child_session_id,)).fetchone()
            if row and row[1] == "auto":
                agent = f" (agent-{row[0]}; watch: harness watch {result.child_session_id})"
        print(
            f"{result.path.name}: {result.status}"
            + (f" ({result.reason})" if result.reason else agent)
        )
    return 0


def cmd_reply(_args: argparse.Namespace) -> int:
    session_id = os.environ.get("HARNESS_SESSION_ID")
    if not session_id:
        raise SessionError("harness reply must run inside a delegated child")
    arm_reply(session_id, os.environ.get("HARNESS_EXECUTION_ID"))
    print("The next successful Stop will reply to the parent")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    resume(args.session_id, " ".join(args.message).strip() or None)
    print(f"Resumed session {args.session_id}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    watch(args.session_id or choose_current_session(), once=args.once)
    return 0


def cmd_loop_launch(args: argparse.Namespace) -> int:
    from subagents_runtime.loop import launch
    parent = args.parent or os.environ.get("HARNESS_SESSION_ID")
    if not parent:
        raise SessionError("loop launch requires a registered Lead session (--parent or HARNESS_SESSION_ID)")
    print(json.dumps(launch(parent, Path(args.cwd), Path(args.prompt_file), difficulty=args.difficulty)))
    return 0


def cmd_loop_lookup(args: argparse.Namespace) -> int:
    from subagents_runtime.loop import lookup
    print(json.dumps(lookup(args.session_id)))
    return 0


def cmd_loop_respond(args: argparse.Namespace) -> int:
    from subagents_runtime.loop import respond, resume
    feedback = None
    if args.loop_command in {"feedback", "resume"}:
        try:
            feedback = Path(args.file).read_text(encoding="utf-8")
        except OSError as exc:
            raise SessionError(f"cannot read feedback file: {exc}") from exc
        if not feedback.strip():
            raise SessionError("feedback file must be nonempty")
    result = (resume(args.session_id, feedback) if args.loop_command == "resume"
              else respond(args.session_id, args.wait_token, feedback=feedback))
    print(json.dumps(result))
    return 0


def cmd_inbox_cleanup(args: argparse.Namespace) -> int:
    from subagents_runtime.inbox_cleanup import cleanup_inboxes

    try:
        results = cleanup_inboxes(
            apply=args.apply, grace_hours=args.grace_hours, offline=args.offline,
        )
    except OSError as exc:
        raise SessionError(f"cannot scan inboxes: {exc}") from exc
    for result in results:
        print(f"{result.status}: {result.path} ({result.reason})")
    print(f"{sum(r.status == 'removed' for r in results)} removed; "
          f"{sum(r.status == 'would-remove' for r in results)} would remove; "
          f"{sum(r.status == 'skipped' for r in results)} skipped")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Launch and continue persistent subagent conversations.",
    )
    parser.add_argument(
        "--version", action="version", version=f"harness subagents {__version__}"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser(
        "run", help="open an independent visible agent session"
    )
    run_parser.add_argument("--provider", choices=("claude", "chatgpt", "pi"), required=True)
    run_parser.add_argument("prompt", nargs="*")
    run_parser.set_defaults(func=cmd_run)
    ask_parser = commands.add_parser(
        "ask", help="process a saved conversation request inbox"
    )
    ask_parser.add_argument("session_id")
    ask_parser.set_defaults(func=cmd_ask)
    reply_parser = commands.add_parser(
        "reply", help="arm the next successful Stop as the parent reply"
    )
    reply_parser.set_defaults(func=cmd_reply)
    resume_parser = commands.add_parser(
        "resume", help="resume a Harness-launched session"
    )
    resume_parser.add_argument("session_id")
    resume_parser.add_argument("message", nargs="*")
    resume_parser.set_defaults(func=cmd_resume)
    watch_parser = commands.add_parser("watch", help="follow a background session's progress")
    watch_parser.add_argument("session_id", nargs="?", help="child session ID or agent-i inside its parent; omit when one background session is active here")
    watch_parser.add_argument("--once", action="store_true", help="show recorded progress and exit")
    watch_parser.set_defaults(func=cmd_watch)
    inbox_parser = commands.add_parser("inbox", help="maintain persistent conversation inbox directories")
    inbox_commands = inbox_parser.add_subparsers(dest="inbox_command", required=True)
    cleanup = inbox_commands.add_parser("cleanup", help="prune empty inactive inboxes, preserving assignments")
    mode = cleanup.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="preview only (the default)")
    mode.add_argument("--apply", action="store_true", help="remove eligible empty directories")
    cleanup.add_argument("--grace-hours", type=float, default=168, help="minimum hours since activity for ended sessions (default: 168, one week)")
    cleanup.add_argument("--offline", action="store_true", help="assert ALL provider sessions using this state directory are stopped; allow legacy/crashed inboxes without lifecycle evidence or grace period (still skips outstanding work)")
    cleanup.set_defaults(func=cmd_inbox_cleanup)
    loop_parser = commands.add_parser("loop", help="launch and inspect a visible loop implementer")
    loop_commands = loop_parser.add_subparsers(dest="loop_command", required=True)
    loop_launch = loop_commands.add_parser("launch")
    loop_launch.add_argument("--parent", help="registered Lead session; defaults to HARNESS_SESSION_ID")
    loop_launch.add_argument("--cwd", required=True, help="initialized worktree directory")
    loop_launch.add_argument("--prompt-file", required=True)
    loop_launch.add_argument("--difficulty", choices=("routine", "basic", "advanced", "expert"))
    loop_launch.set_defaults(func=cmd_loop_launch)
    loop_lookup = loop_commands.add_parser("lookup")
    loop_lookup.add_argument("session_id")
    loop_lookup.set_defaults(func=cmd_loop_lookup)
    for command in ("feedback", "release", "resume"):
        response = loop_commands.add_parser(command)
        response.add_argument("session_id")
        if command != "resume":
            response.add_argument("--wait-token", required=True)
        if command != "release":
            response.add_argument("--file", required=True)
        response.set_defaults(func=cmd_loop_respond)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (SessionError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
