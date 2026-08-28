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
    require_supported,
    substitute,
    uninstall,
)
from harness_cli.manifest import ManifestError, SupportStatus, Tool, discover
from harness_cli.platforms import Platform


def _platforms_from_args(args: argparse.Namespace) -> tuple[Platform, ...]:
    """Return explicit platforms, or every platform when the flag is omitted."""
    selected = args.platforms or list(Platform)
    return tuple(dict.fromkeys(Platform.parse(platform) for platform in selected))


def _target_from_args(args: argparse.Namespace, platform: Platform) -> Target:
    if args.user:
        # Claude Code reads only settings.json at the user level, and --dir names
        # a project, so both flags are meaningless here rather than merely odd.
        if args.local:
            raise InstallError("--user and --local are mutually exclusive")
        if args.dir is not None:
            raise InstallError("--dir applies to a project install; drop it or drop --user")
        return Target.for_user(platform=platform)
    settings_name = "settings.local.json" if args.local else "settings.json"
    return Target.for_project(Path(args.dir or ".").resolve(), settings_name, platform=platform)


def _targets_from_args(args: argparse.Namespace) -> tuple[Target, ...]:
    return tuple(_target_from_args(args, platform) for platform in _platforms_from_args(args))


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


def _gitignore_diff(plan: Plan) -> str:
    name = plan.target.gitignore_path.name
    return "".join(
        difflib.unified_diff(
            plan.gitignore_before.splitlines(keepends=True),
            plan.gitignore_after.splitlines(keepends=True),
            f"a/{name}",
            f"b/{name}",
        )
    )


def _print_plan(plan: Plan) -> None:
    print(f"{plan.tool.name} {plan.tool.version} -> {plan.target.install_root}")
    for action in sorted(plan.files, key=lambda a: str(a.path)):
        shown = action.dest if plan.target.platform is Platform.CLAUDE else (
            action.path.as_posix()
            if plan.target.is_user
            else action.path.relative_to(plan.target.scope_root).as_posix()
        )
        print(f"  {action.status:>10}  {shown}")
    if plan.settings_changed:
        print(f"  settings changes to {plan.target.settings_name}:")
        for line in _settings_diff(plan).splitlines():
            print(f"    {line}")
    elif plan.fragment:
        print(f"  {plan.target.settings_name}: already up to date")
    if plan.gitignore_changed:
        # Spelt out in full: for a project install this is the one file written
        # outside .claude/, which is worth seeing before it happens.
        print(f"  keeping secrets out of git, via {plan.target.gitignore_path}:")
        for line in _gitignore_diff(plan).splitlines():
            print(f"    {line}")
    elif plan.tool.gitignore:
        print(f"  {plan.target.gitignore_path.name}: already up to date")
    if plan.missing_requirements:
        print(f"  ! missing on PATH: {', '.join(plan.missing_requirements)}")


def cmd_list(args: argparse.Namespace) -> int:
    available = discover()
    targets = _targets_from_args(args)
    width = max((len(n) for n in available), default=0)
    for index, target in enumerate(targets):
        if len(targets) > 1:
            if index:
                print()
            print(f"{target.adapter.product_name}:")
        any_installed = False
        for name, tool in available.items():
            support = tool.support_for(target.platform)
            installed = is_installed(tool, target)
            any_installed = any_installed or installed
            mark = "*" if installed else " "
            suffix = ""
            if support.status is SupportStatus.REPLACEMENT:
                suffix = f"  [replacement: {support.replacement}]"
            elif support.status is SupportStatus.UNSUPPORTED:
                suffix = "  [unsupported]"
            print(f"{mark} {name.ljust(width)}  {tool.description}{suffix}")
        if any_installed:
            if target.platform is Platform.CLAUDE:
                print(f"\n* installed in {target.install_root}")
            else:
                print(
                    f"\n* installed for {target.adapter.product_name} in {target.install_root}"
                )
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    tool = _resolve([args.tool], discover())[0]
    targets = _targets_from_args(args)
    print(f"{tool.name} {tool.version}\n{tool.description}\n")
    for index, target in enumerate(targets):
        support = tool.support_for(target.platform)
        if len(targets) > 1:
            if index:
                print()
            print(f"{target.adapter.product_name}: {support.status.value}")
        elif target.platform is not Platform.CLAUDE or support.status is not SupportStatus.SUPPORTED:
            print(f"{target.adapter.product_name}: {support.status.value}")
        if support.replacement:
            print(f"Replacement: {support.replacement}")
        if support.reason:
            print(f"Reason: {support.reason}")
        if support.status is not SupportStatus.SUPPORTED:
            continue
        if tool.requires:
            print(f"Requires: {', '.join(tool.requires)}")
        print("Files:")
        for payload in tool.expand(target.platform):
            path = target.destination_path(payload.root, payload.dest)
            shown = (
                path.as_posix()
                if target.is_user
                else path.relative_to(target.scope_root).as_posix()
            )
            print(f"  {shown}{'  (executable)' if payload.executable else ''}")
        if tool.gitignore:
            print("\nAdded to .gitignore:")
            for entry in tool.gitignore:
                print(f"  {target.gitignore_pattern(entry)}")
        fragment = tool.fragment_for(target.platform)
        if fragment:
            print(f"\n{target.settings_name} fragment:")
            for line in settings_merge.dumps(substitute(fragment, target)).splitlines():
                print(f"  {line}")
    if tool.docs:
        print(f"\nDocs: {tool.docs}")
    return 0


def _run_install(
    args: argparse.Namespace, batches: list[tuple[Target, list[Tool]]]
) -> int:
    """Validate and install platform batches as one command."""
    nonempty = [(target, tools) for target, tools in batches if tools]
    if not nonempty:
        products = ", ".join(target.adapter.product_name for target, _ in batches)
        raise InstallError(f"no tools are installable for the selected target(s): {products}")

    # Validate and plan the whole cross-platform batch before writing anything.
    for target, tools in nonempty:
        for tool in tools:
            require_supported(tool, target)

    # Settings are platform-specific, while project .gitignore is shared. Maps
    # let every plan build on prior virtual changes, including during --dry.
    pending_settings: dict[Path, dict] = {}
    pending_ignores: dict[Path, str] = {}
    planned: list[tuple[Target, list[Plan]]] = []
    for target, tools in nonempty:
        target_plans = []
        for tool in tools:
            plan = plan_install(
                tool,
                target,
                settings_override=pending_settings.get(target.settings_path),
                gitignore_override=pending_ignores.get(target.gitignore_path),
                force=getattr(args, "force", False),
            )
            pending_settings[target.settings_path] = plan.settings_after
            pending_ignores[target.gitignore_path] = plan.gitignore_after
            target_plans.append(plan)
        planned.append((target, target_plans))

    for index, (target, plans) in enumerate(planned):
        if len(batches) > 1:
            if index:
                print()
            print(f"{target.adapter.product_name}:")
        for plan in plans:
            _print_plan(plan)
            if not args.dry:
                for note in apply_install(plan):
                    print(f"  note: {note}")

    if args.dry:
        print("\n(dry run — nothing written)")
    else:
        for target, _ in nonempty:
            print(f"\n{target.adapter.restart_guidance}")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    available = discover()
    targets = _targets_from_args(args)
    requested = None if args.tools == ["all"] else _resolve(args.tools, available)
    batches = [
        (
            target,
            [
                tool
                for tool in available.values()
                if tool.support_for(target.platform).status is SupportStatus.SUPPORTED
            ]
            if requested is None
            else requested,
        )
        for target in targets
    ]
    return _run_install(args, batches)


def cmd_uninstall(args: argparse.Namespace) -> int:
    available = discover()
    targets = _targets_from_args(args)
    requested = None if args.tools == ["all"] else _resolve(args.tools, available)
    batches = [
        (
            target,
            [tool for tool in available.values() if is_installed(tool, target)]
            if requested is None
            else requested,
        )
        for target in targets
    ]
    # A named cross-platform removal is strict and validates before mutation.
    for target, tools in batches:
        for tool in tools:
            require_supported(tool, target)
    for index, (target, tools) in enumerate(batches):
        if len(targets) > 1 and tools:
            if index:
                print()
            print(f"{target.adapter.product_name}:")
        for tool in tools:
            print(f"{tool.name} -> {target.install_root}")
            for note in uninstall(tool, target, force=args.force):
                print(f"  note: {note}")
    return 0


def cmd_upgrade(args: argparse.Namespace) -> int:
    available = discover()
    targets = _targets_from_args(args)
    if args.tools:
        tools = _resolve(args.tools, available)
        return _run_install(args, [(target, tools) for target in targets])

    batches = [
        (target, [tool for tool in available.values() if is_installed(tool, target)])
        for target in targets
    ]
    if not any(tools for _, tools in batches):
        for target in targets:
            if target.platform is Platform.CLAUDE:
                print(f"nothing installed in {target.install_root}")
            else:
                print(
                    f"nothing installed for {target.adapter.product_name} "
                    f"in {target.install_root}"
                )
        return 0
    return _run_install(args, batches)


def _add_target_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--platform",
        dest="platforms",
        choices=[platform.value for platform in Platform],
        action="append",
        help="installation target; repeat to select multiple (default: all)",
    )
    parser.add_argument("--dir", help="project root to install into (default: cwd)")
    parser.add_argument(
        "--user",
        "--global",
        dest="user",
        action="store_true",
        help="install machine-wide for the selected platforms, for every project",
    )
    parser.add_argument(
        "--local", action="store_true", help="write to settings.local.json (project scope only)"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness", description="Install tools from the harness collection."
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="list available and installed tools")
    _add_target_flags(p_list)
    p_list.set_defaults(func=cmd_list)

    p_info = sub.add_parser("info", help="show what a tool installs")
    p_info.add_argument("tool")
    _add_target_flags(p_info)
    p_info.set_defaults(func=cmd_info)

    p_install = sub.add_parser("install", help="install one or more tools (or 'all')")
    p_install.add_argument("tools", nargs="+")
    _add_target_flags(p_install)
    p_install.add_argument("--dry", action="store_true", help="show what would change")
    p_install.add_argument(
        "--force",
        action="store_true",
        help="overwrite starter files you edited instead of keeping them",
    )
    p_install.set_defaults(func=cmd_install)

    p_remove = sub.add_parser("uninstall", help="remove installed tools (or 'all')")
    p_remove.add_argument("tools", nargs="+")
    _add_target_flags(p_remove)
    p_remove.add_argument("--force", action="store_true", help="delete locally modified files too")
    p_remove.set_defaults(func=cmd_uninstall)

    p_up = sub.add_parser("upgrade", help="reinstall installed tools at the shipped version")
    p_up.add_argument("tools", nargs="*")
    _add_target_flags(p_up)
    p_up.add_argument("--dry", action="store_true")
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
