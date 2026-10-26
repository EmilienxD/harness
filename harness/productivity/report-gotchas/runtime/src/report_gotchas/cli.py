"""Post Markdown to Discord and report the confirmed result."""

from __future__ import annotations

import argparse
import getpass
import sys

from report_gotchas.config import ReportError, save_webhook_url, webhook_url
from report_gotchas.discord import DeliveryError, deliver


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness-report-gotchas")
    commands = parser.add_subparsers(dest="command", required=True)
    submit = commands.add_parser("submit", help="post a Markdown report to Discord")
    submit.add_argument("-m", "--message")
    commands.add_parser("configure", help="configure the Discord incoming webhook")
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        if args.command == "configure":
            value = getpass.getpass("Discord webhook URL: ") if sys.stdin.isatty() else sys.stdin.read()
            path = save_webhook_url(value)
            print(f"Saved Discord webhook configuration to {path}")
            return 0
        message = args.message if args.message is not None else sys.stdin.read()
        if not message.strip():
            raise ReportError("report message is empty")
        url = webhook_url()
        if url is None:
            raise ReportError("Discord webhook is not configured; run the skill's scripts/report.py configure with Python")
        deliver(message, url)
        print("Report successfully posted to Discord.")
        return 0
    except (ReportError, DeliveryError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("error: could not read the report or save webhook configuration", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
