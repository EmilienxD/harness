"""Persistent session commands for the subagents bundle."""

from __future__ import annotations

import argparse
import os
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
    run_parser.add_argument("--provider", choices=("claude", "chatgpt"), required=True)
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
