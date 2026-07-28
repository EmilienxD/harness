"""`harness` command line: install, uninstall, upgrade, list, info."""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

from harness_cli import __version__, settings_merge
from harness_cli.installer import (
    InstallError,
    Plan,
    Target,
    apply_install,
    is_installed,
    plan_install,
    substitute,
    uninstall,
)
from harness_cli.manifest import ManifestError, Tool, discover


def _target_from_args(args: argparse.Namespace) -> Target:
    if args.user:
        # Claude Code reads only settings.json at the user level, and --dir names
        # a project, so both flags are meaningless here rather than merely odd.
        if args.local:
            raise InstallError("--user and --local are mutually exclusive")
        if args.dir is not None:
            raise InstallError("--dir applies to a project install; drop it or drop --user")
        return Target.for_user()
    settings_name = "settings.local.json" if args.local else "settings.json"
    return Target.for_project(Path(args.dir or ".").resolve(), settings_name)


def _resolve(names: list[str], available: dict[str, Tool]) -> list[Tool]:
    if names == ["all"]:
        return list(available.values())
    missing = [n for n in names if n not in available]
    if missing:
        raise InstallError(
            f"unknown tool(s): {', '.join(missing)}\nAvailable: {', '.join(available)}"
        )
    return [available[n] for n in names]


def _settings_diff(plan: Plan) -> str:
    before = settings_merge.dumps(plan.settings_before).splitlines(keepends=True)
    after = settings_merge.dumps(plan.settings_after).splitlines(keepends=True)
    name = plan.target.settings_name
    return "".join(difflib.unified_diff(before, after, f"a/{name}", f"b/{name}"))


def _print_plan(plan: Plan) -> None:
    print(f"{plan.tool.name} {plan.tool.version} -> {plan.target.claude_dir}")
    for action in sorted(plan.files, key=lambda a: a.dest):
        print(f"  {action.status:>10}  {action.dest}")
    if plan.settings_changed:
        print(f"  settings changes to {plan.target.settings_name}:")
        for line in _settings_diff(plan).splitlines():
            print(f"    {line}")
    elif plan.tool.fragment:
        print(f"  {plan.target.settings_name}: already up to date")
    if plan.missing_requirements:
        print(f"  ! missing on PATH: {', '.join(plan.missing_requirements)}")


def cmd_list(args: argparse.Namespace) -> int:
    available = discover()
    target = _target_from_args(args)
    width = max((len(n) for n in available), default=0)
    any_installed = False
    for name, tool in available.items():
        installed = is_installed(tool, target)
        any_installed = any_installed or installed
        mark = "*" if installed else " "
        print(f"{mark} {name.ljust(width)}  {tool.description}")
    if any_installed:
        print(f"\n* installed in {target.claude_dir}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    tool = _resolve([args.tool], discover())[0]
    print(f"{tool.name} {tool.version}\n{tool.description}\n")
    if tool.requires:
        print(f"Requires: {', '.join(tool.requires)}")
    print("Files:")
    for _, dest, executable in tool.expand():
        print(f"  .claude/{dest}{'  (executable)' if executable else ''}")
    if tool.fragment:
        print("\nsettings.json fragment:")
        for line in settings_merge.dumps(substitute(tool.fragment)).splitlines():
            print(f"  {line}")
    if tool.docs:
        print(f"\nDocs: {tool.docs}")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    tools = _resolve(args.tools, discover())
    target = _target_from_args(args)

    # Each tool's fragment must merge onto what the previous tool wrote, not
    # onto the original file — otherwise the last install wins and silently
    # drops the others' hooks.
    pending: dict | None = None
    for tool in tools:
        plan = plan_install(tool, target, settings_override=pending)
        _print_plan(plan)
        if args.dry_run:
            pending = plan.settings_after
            continue
        for note in apply_install(plan):
            print(f"  note: {note}")

    if args.dry_run:
        print("\n(dry run — nothing written)")
    elif tools:
        print("\nRestart Claude Code (or run /doctor) to pick up the changes.")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    available = discover()
    target = _target_from_args(args)
    tools = (
        [t for t in available.values() if is_installed(t, target)]
        if args.tools == ["all"]
        else _resolve(args.tools, available)
    )
    for tool in tools:
        print(f"{tool.name} -> {target.claude_dir}")
        for note in uninstall(tool, target, force=args.force):
            print(f"  note: {note}")
    return 0


def cmd_upgrade(args: argparse.Namespace) -> int:
    available = discover()
    target = _target_from_args(args)
    installed = [name for name, tool in available.items() if is_installed(tool, target)]
    if not args.tools and not installed:
        print(f"nothing installed in {target.claude_dir}")
        return 0
    args.tools = args.tools or installed
    return cmd_install(args)


def _add_target_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dir", help="project root to install into (default: cwd)")
    parser.add_argument(
        "--user",
        "--global",
        dest="user",
        action="store_true",
        help="install machine-wide into ~/.claude, for every project",
    )
    parser.add_argument(
        "--local", action="store_true", help="write to settings.local.json (project scope only)"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness", description="Install Claude Code tools from the harness collection."
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="list available and installed tools")
    _add_target_flags(p_list)
    p_list.set_defaults(func=cmd_list)

    p_info = sub.add_parser("info", help="show what a tool installs")
    p_info.add_argument("tool")
    p_info.set_defaults(func=cmd_info)

    p_install = sub.add_parser("install", help="install one or more tools (or 'all')")
    p_install.add_argument("tools", nargs="+")
    _add_target_flags(p_install)
    p_install.add_argument("--dry-run", action="store_true", help="show what would change")
    p_install.set_defaults(func=cmd_install)

    p_remove = sub.add_parser("uninstall", help="remove installed tools (or 'all')")
    p_remove.add_argument("tools", nargs="+")
    _add_target_flags(p_remove)
    p_remove.add_argument("--force", action="store_true", help="delete locally modified files too")
    p_remove.set_defaults(func=cmd_uninstall)

    p_up = sub.add_parser("upgrade", help="reinstall installed tools at the shipped version")
    p_up.add_argument("tools", nargs="*")
    _add_target_flags(p_up)
    p_up.add_argument("--dry-run", action="store_true")
    p_up.set_defaults(func=cmd_upgrade)

    return parser


def main(argv: list[str] | None = None) -> int:
    # The default Windows console codepage mangles non-ASCII output (em dashes
    # in tool descriptions, arrows in diffs) into '?' or a UnicodeEncodeError.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (InstallError, ManifestError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
