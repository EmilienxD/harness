"""Harness: one catalogue menu and four standalone session commands."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from harness_cli import __version__
from harness_cli.installer import CatalogueInstaller, InstallError, Target
from harness_cli.manifest import ManifestError, SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.sessions import SessionError, ask, launch, reply, resume


def _choice(prompt: str, options: tuple[str, ...], default: int = 0) -> int:
    rendered = "/".join(
        f"[{option}]" if index == default else option for index, option in enumerate(options)
    )
    value = input(f"{prompt} ({rendered}): ").strip().lower()
    if not value:
        return default
    matches = [index for index, option in enumerate(options) if option.lower().startswith(value)]
    if len(matches) != 1:
        raise InstallError(f"invalid choice '{value}'")
    return matches[0]


def catalogue_menu() -> int:
    if not sys.stdin.isatty():
        raise InstallError("the catalogue is interactive; run `harness` in a terminal")
    print("Harness catalogue\n")
    scope = _choice("Install agent packages for", ("this project", "this user"))
    platform_index = _choice("Agent platform", ("Claude Code", "ChatGPT"))
    platform = (Platform.CLAUDE, Platform.CHATGPT)[platform_index]
    target = Target.for_project(Path.cwd(), platform) if scope == 0 else Target.for_user(platform)
    available = discover()
    installer = CatalogueInstaller(available, target)
    explicit = installer.explicit_packages()
    installed = installer.installation["packages"]
    shown = [
        tool
        for tool in available.values()
        if tool.support_for(platform).status is SupportStatus.SUPPORTED
    ]
    print(f"\nTarget: {target.install_root}")
    for index, tool in enumerate(shown, 1):
        mark = "x" if tool.name in explicit else "-" if tool.name in installed else " "
        suffix = " (dependency)" if mark == "-" else ""
        print(f" {index:>2}. [{mark}] {tool.name:<30} {tool.description}{suffix}")
    print("\nEnter the numbers that should remain explicitly installed.")
    raw = input("Selection (comma-separated, blank keeps current): ").strip()
    if raw:
        try:
            numbers = {int(part.strip()) for part in raw.split(",") if part.strip()}
        except ValueError as exc:
            raise InstallError("selection must contain comma-separated package numbers") from exc
        invalid = sorted(number for number in numbers if number < 1 or number > len(shown))
        if invalid:
            raise InstallError(f"unknown package number(s): {', '.join(map(str, invalid))}")
        explicit = {shown[number - 1].name for number in numbers}
    _, changes = installer.plan(explicit)
    if not changes:
        print("\nCatalogue already matches that selection.")
        return 0
    print("\nChanges:")
    for change in changes:
        suffix = f" ({change.reason})" if change.reason else ""
        print(f"  {change.action:<9} {change.package}{suffix}")
    if _choice("Apply", ("yes", "no"), 1) != 0:
        print("No changes made.")
        return 0
    installer.reconcile(explicit)
    print("Catalogue updated.")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    session_id = launch(" ".join(args.prompt).strip() or None)
    print(f"Started visible session {session_id}")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    prompt = " ".join(args.prompt).strip()
    if not prompt:
        raise SessionError("harness ask requires a prompt")
    request_id, child_id = ask(prompt)
    print(f"Started child {child_id} for request {request_id}")
    return 0


def cmd_reply(args: argparse.Namespace) -> int:
    message = " ".join(args.message).strip()
    if not message:
        raise SessionError("harness reply requires a message")
    print(f"Reply queued as delivery {reply(message)}")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    resume(args.session_id)
    print(f"Resumed visible session {args.session_id}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Manage the Harness catalogue, or launch persistent visible agent sessions.",
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    commands = parser.add_subparsers(dest="command")
    run_parser = commands.add_parser("run", help="open an independent visible Claude session")
    run_parser.add_argument("prompt", nargs="*")
    run_parser.set_defaults(func=cmd_run)
    ask_parser = commands.add_parser("ask", help="ask a child in an independent visible terminal")
    ask_parser.add_argument("prompt", nargs="+")
    ask_parser.set_defaults(func=cmd_ask)
    reply_parser = commands.add_parser("reply", help="reply once to the parent that launched this child")
    reply_parser.add_argument("message", nargs="+")
    reply_parser.set_defaults(func=cmd_reply)
    resume_parser = commands.add_parser("resume", help="resume a Harness-launched session")
    resume_parser.add_argument("session_id")
    resume_parser.set_defaults(func=cmd_resume)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args) if args.command else catalogue_menu()
    except (InstallError, ManifestError, SessionError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
