"""Command-line entrypoint for report submission and configuration."""

from __future__ import annotations

import argparse
import getpass
import sys
import time

from report_gotchas.config import save_webhook_url, webhook_url
from report_gotchas.discord import DeliveryError, deliver
from report_gotchas.reports import ReportError, queued_receipts, submit


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness-report-gotchas")
    commands = parser.add_subparsers(dest="command", required=True)
    submit_parser = commands.add_parser("submit", help="submit a Markdown report")
    submit_parser.add_argument("-m", "--message")
    commands.add_parser("configure", help="configure the Discord incoming webhook")
    deliver_parser = commands.add_parser("deliver", help=argparse.SUPPRESS)
    deliver_parser.add_argument("receipt")
    commands.add_parser("retry", help="retry all queued reports")
    return parser


def _configure() -> int:
    if sys.stdin.isatty():
        value = getpass.getpass("Discord webhook URL: ")
    else:
        value = sys.stdin.read()
    path = save_webhook_url(value)
    print(f"Saved Discord webhook configuration to {path}")
    pending = _retry()
    if pending:
        print(f"Delivered {pending} queued report{'s' if pending != 1 else ''}")
    return 0


def _deliver(receipt: str) -> int:
    url = webhook_url()
    if url is None:
        raise ReportError("Discord webhook is not configured; run harness-report-gotchas configure")
    for attempt in range(9):
        try:
            deliver(receipt, url)
            return 0
        except DeliveryError as exc:
            if not exc.retryable or attempt == 8:
                raise ReportError(str(exc)) from exc
            delay = exc.retry_after if exc.retry_after is not None else min(2**attempt, 300)
            time.sleep(max(0.1, delay))
    return 1


def _retry() -> int:
    receipts = queued_receipts()
    for receipt in receipts:
        _deliver(receipt)
    return len(receipts)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        if args.command == "submit":
            message = args.message if args.message is not None else sys.stdin.read()
            receipt = submit(message)
            print(f"HARNESS_REPORT_GOTCHAS_RECEIPT:{receipt}")
            return 0
        if args.command == "configure":
            return _configure()
        if args.command == "deliver":
            return _deliver(args.receipt)
        if args.command == "retry":
            count = _retry()
            print(f"Delivered {count} queued report{'s' if count != 1 else ''}")
            return 0
    except ReportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
