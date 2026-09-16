"""Ephemeral interactive catalogue installer."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from harness_cli import __version__
from harness_cli.installer import (
    CatalogueInstaller,
    Change,
    InstallError,
    Target,
    installed_packages,
    reconcile_targets,
)
from harness_cli.installer_cli import UsageError, run as run_installer_command
from harness_cli.manifest import ManifestError, SupportStatus, Tool, discover
from harness_cli.platforms import Platform, get_adapter
from harness_cli.receipts import ReceiptStore, installation_lock, package_ownership
from harness_cli.tui import Line, MenuOption, TerminalUI, terminal_keys


PLATFORMS = (Platform.CLAUDE, Platform.CHATGPT)


class HarnessArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UsageError(message)


# Reading order for the catalogue: the workflow categories first, then the
# cross-cutting ones, with retired packages last.
CATEGORY_ORDER = (
    "planning",
    "building",
    "engineering",
    "shipping",
    "productivity",
    "guards",
    "extension",
)


def _category(tool: Tool) -> str:
    return tool.root.parent.name


def _category_rank(tool: Tool) -> tuple[int, str]:
    category = _category(tool)
    if category == "deprecated":
        return 2, category
    if category in CATEGORY_ORDER:
        return 0, f"{CATEGORY_ORDER.index(category):02d}"
    return 1, category


def _tool_options(
    tools: list[Tool],
    installed: set[str],
    platforms: tuple[Platform, ...] = PLATFORMS,
) -> list[MenuOption]:
    return [
        MenuOption(
            label=tool.name,
            detail=tool.description,
            group=_category(tool),
            badge="; ".join(
                f"{get_adapter(platform).product_name} not supported"
                for platform in platforms
                if tool.support_for(platform).status is not SupportStatus.SUPPORTED
            ),
            installed=tool.name in installed,
        )
        for tool in tools
    ]


def _provider_options() -> tuple[MenuOption, ...]:
    return tuple(
        MenuOption(get_adapter(platform).product_name)
        for platform in PLATFORMS
    )


def _cancel(ui: TerminalUI) -> None:
    """Render a consistent cancellation status, including for test doubles."""

    handler = getattr(ui, "cancelled", ui.outro)
    handler("Installation cancelled.  No changes made.")


def _targets(scope: int, platforms: tuple[Platform, ...]) -> list[Target]:
    if scope == 0:
        return [Target.for_project(Path.cwd(), platform) for platform in platforms]
    return [Target.for_user(platform) for platform in platforms]


def _root_packages(targets: list[Target], store: ReceiptStore) -> set[str]:
    return {
        name
        for target in targets
        for name, receipt in installed_packages(target, store).items()
        if package_ownership(receipt) in {"selected", "retained"}
    }


def _skip_line(tool: Tool, platform: Platform) -> str:
    support = tool.support_for(platform)
    product = get_adapter(platform).product_name
    if support.status is SupportStatus.REPLACEMENT:
        return f"    ○ {tool.name}: skipped for {product}. Alternative: {support.replacement}"
    reason = f" {support.reason}" if support.reason else ""
    return f"    ○ {tool.name}: skipped for {product}.{reason}"


# Additions first and removals last, so the summary reads as what a target
# gains before what it loses.
_ACTION_MARKS = {
    "install": "+ install",
    "upgrade": "↑ upgrade",
    "update": "~ update",
    "ownership": "~ ownership",
    "retain": "= retain",
    "remove": "- remove",
}
_ACTION_TONES = {
    "install": "success",
    "upgrade": "accent",
    "update": "accent",
    "ownership": "muted",
    "retain": "muted",
    "remove": "danger",
}


def _group_changes(changes: list[Change]) -> dict[str, tuple[str, list[str]]]:
    """Collect one target's changes into marked rows, additions first."""
    ranked = sorted(
        changes,
        key=lambda change: list(_ACTION_MARKS).index(change.action)
        if change.action in _ACTION_MARKS
        else len(_ACTION_MARKS),
    )
    grouped: dict[str, tuple[str, list[str]]] = {}
    for change in ranked:
        mark = _ACTION_MARKS.get(change.action, f"~ {change.action}")
        grouped.setdefault(mark, (_ACTION_TONES.get(change.action, ""), []))[1].append(
            change.package
        )
    return grouped


def _review_lines(
    tools: list[Tool],
    selected_names: set[str],
    targets: list[Target],
    changes_by_platform: dict[Platform, list[Change]],
) -> list[str]:
    scope = "Global" if targets[0].is_user else "Project"
    platforms = ", ".join(target.adapter.product_name for target in targets)
    lines = [f"  Install to  {scope}", f"  Platforms   {platforms}", ""]
    grouped_by_target = [
        _group_changes(changes_by_platform[target.platform]) for target in targets
    ]
    column = max(
        (len(mark) for grouped in grouped_by_target for mark in grouped),
        default=0,
    )
    for target, grouped in zip(targets, grouped_by_target):
        lines.append(f"  {target.adapter.product_name}")
        if not grouped:
            lines.append(Line("    ✓ Already up to date", "success"))
        for mark, (tone, packages) in grouped.items():
            listed = ", ".join(sorted(packages))
            lines.append(Line(f"    {mark:<{column}} ({len(packages)})  {listed}", tone))
    skips = [
        _skip_line(tool, target.platform)
        for target in targets
        for tool in tools
        if tool.name in selected_names
        and tool.support_for(target.platform).status is not SupportStatus.SUPPORTED
    ]
    if skips:
        lines.extend(("", "  Skipped", *skips))
    return lines


def _overwrite_lines(paths: list[Path]) -> list[str]:
    return [
        "  These files already exist and were not installed by Harness.",
        "  Answering Yes replaces their contents with the catalogue version,",
        "  and a later uninstall removes them.",
        "",
        *(f"    {path}" for path in paths),
    ]


def _adoption_lines(products: dict[str, set[str]]) -> list[str]:
    return [
        "  These machine-level products are already installed and no Harness",
        "  receipt accounts for them.  Answering Yes replaces each with the",
        "  version this catalogue pins, and a later uninstall removes it.",
        "",
        *(
            f"    {described}  ({name})"
            for name in sorted(products)
            for described in sorted(products[name])
        ),
    ]


def catalogue_menu(*, local: Path | None = None, root: Path | None = None) -> int:
    if not sys.stdin.isatty():
        raise InstallError("the catalogue is interactive; run `harness` in a terminal")
    available = discover(local=local) if local is not None else discover()
    if root is not None:
        root = root.expanduser().resolve()
        if not root.is_dir():
            raise UsageError(f"project root is not an existing directory: {root}")
    tools = sorted(
        (tool for tool in available.values() if tool.selectable),
        key=lambda tool: (_category_rank(tool), tool.name),
    )
    store = ReceiptStore.load()
    with terminal_keys() as read_key:
        ui = TerminalUI(read_key)
        ui.intro("harness")

        provider_selection = ui.multiselect(
            "Select providers",
            _provider_options(),
            selected={0, 1},
            required=True,
            searchable=False,
        )
        if provider_selection is None:
            _cancel(ui)
            return 0

        platforms = tuple(PLATFORMS[index] for index in sorted(provider_selection))
        scope = ui.select(
            "Installation scope",
            (
                MenuOption("Project", "Install in current directory (committed with your project)"),
                MenuOption("Global", "Install in home directory (available across all projects)"),
            ),
        )
        if scope is None:
            _cancel(ui)
            return 0

        targets = (
            [Target.for_project(root, platform) for platform in platforms]
            if scope == 0 and root is not None else _targets(scope, platforms)
        )
        installed = _root_packages(targets, store)
        package_selection = ui.multiselect(
            "Select packages",
            _tool_options(tools, installed, platforms),
            selected={index for index, tool in enumerate(tools) if tool.name in installed},
            select_all=True,
            select_groups=True,
        )
        if package_selection is None:
            _cancel(ui)
            return 0
        selected_names = {tools[index].name for index in package_selection}

        installers = [CatalogueInstaller(available, target, store) for target in targets]
        requests = {
            target.platform: {
                name
                for name in selected_names
                if available[name].support_for(target.platform).status is SupportStatus.SUPPORTED
            }
            for target in targets
        }
        if selected_names and not any(requests.values()):
            ui.note(
                "No compatible packages",
                ("None of the selected packages support the selected providers.",),
            )
            _cancel(ui)
            return 0

        changes_by_platform = {}
        for installer in installers:
            _, changes = installer.plan(requests[installer.target.platform])
            changes_by_platform[installer.target.platform] = changes
        if not any(changes_by_platform.values()):
            ui.outro("Catalogue already matches that selection.")
            return 0

        ui.note(
            "Installation Summary",
            _review_lines(tools, selected_names, targets, changes_by_platform),
        )
        if ui.confirm("Proceed with changes?") is not True:
            _cancel(ui)
            return 0

        overwrite = sorted(
            {
                path
                for installer in installers
                for path in installer.conflicts(requests[installer.target.platform])
            }
        )
        if overwrite:
            ui.note("Existing files", _overwrite_lines(overwrite))
            if ui.confirm("Overwrite these files?", default=False) is not True:
                _cancel(ui)
                return 0

        products: dict[str, set[str]] = {}
        for installer in installers:
            found = installer.unowned_host_products(requests[installer.target.platform])
            for name, described in found.items():
                products.setdefault(name, set()).update(described)
        if products:
            ui.note("Existing host products", _adoption_lines(products))
            if ui.confirm("Take ownership of these?", default=False) is not True:
                _cancel(ui)
                return 0
        adopt = set(products)

        def apply_changes() -> None:
            with installation_lock():
                locked_store = ReceiptStore.load()
                locked_installers = [
                    CatalogueInstaller(available, target, locked_store)
                    for target in targets
                ]
                locked_changes = {
                    installer.target.platform: installer.plan(
                        requests[installer.target.platform]
                    )[1]
                    for installer in locked_installers
                }
                if locked_changes != changes_by_platform:
                    raise InstallError(
                        "installation state changed while awaiting confirmation; run Harness again"
                    )
                reconcile_targets(
                    [
                        (installer, requests[installer.target.platform])
                        for installer in locked_installers
                    ],
                    overwrite=overwrite,
                    adopt=adopt,
                )

        ui.progress("Applying catalogue changes", "Catalogue updated", apply_changes)
        ui.outro("Done!  Review installed packages before use.")
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = HarnessArgumentParser(
        prog="harness",
        description="Install and reconcile the Harness catalogue.",
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    parser.add_argument("--local", type=Path, help="use a local Harness checkout and its Python runtimes")
    parser.add_argument("--root", type=Path, help="project root (default: current directory)")
    commands = parser.add_subparsers(dest="command")
    install = commands.add_parser(
        "install",
        help="add packages without changing other selections",
        description="Install named packages while preserving the other packages selected for each target.",
    )
    install.add_argument("packages", nargs="*", metavar="PACKAGE")
    install.add_argument("--all", action="store_true", help="install every supported package")
    install.add_argument(
        "--platform", action="append", choices=[item.value for item in PLATFORMS],
        help="target platform; repeat to select several (default: both)",
    )
    install.add_argument(
        "--scope", choices=("project", "user"), default="project",
        help="installation scope (default: project)",
    )
    install.add_argument("--root", type=Path, default=argparse.SUPPRESS, help="project root (default: current directory)")
    install.add_argument("--dry-run", action="store_true", help="print the plan without changing files")
    install.add_argument(
        "--overwrite", action="store_true",
        help="replace existing destination files Harness does not own",
    )
    install.add_argument(
        "--adopt", action="store_true",
        help="take ownership of host products already installed outside Harness",
    )
    install.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    install.set_defaults(operation="install")
    uninstall = commands.add_parser(
        "uninstall", aliases=["remove"], help="remove named packages",
        description="Remove named selections, or every selection with --all.",
    )
    uninstall.add_argument("packages", nargs="*", metavar="PACKAGE")
    uninstall.add_argument("--all", action="store_true", help="remove every selected or retained package")
    uninstall.add_argument(
        "--platform", action="append", choices=[item.value for item in PLATFORMS],
        help="target platform; repeat to select several (default: both)",
    )
    uninstall.add_argument(
        "--scope", choices=("project", "user"), default="project",
        help="installation scope (default: project)",
    )
    uninstall.add_argument("--root", type=Path, default=argparse.SUPPRESS, help="project root (default: current directory)")
    uninstall.add_argument("--dry-run", action="store_true", help="print the plan without changing files")
    uninstall.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    uninstall.set_defaults(operation="uninstall")
    upgrade = commands.add_parser(
        "upgrade", aliases=["update"], help="upgrade installed packages",
        description="Reconcile every installed selection to the versions in this pinned catalogue.",
    )
    upgrade.add_argument(
        "--platform", action="append", choices=[item.value for item in PLATFORMS],
        help="target platform; repeat to select several (default: both)",
    )
    upgrade.add_argument(
        "--scope", choices=("project", "user"), default="project",
        help="installation scope (default: project)",
    )
    upgrade.add_argument("--root", type=Path, default=argparse.SUPPRESS, help="project root (default: current directory)")
    upgrade.add_argument("--dry-run", action="store_true", help="print the plan without changing files")
    upgrade.add_argument(
        "--overwrite", action="store_true",
        help="replace existing destination files Harness does not own",
    )
    upgrade.add_argument(
        "--adopt", action="store_true",
        help="take ownership of host products already installed outside Harness",
    )
    upgrade.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    upgrade.set_defaults(operation="upgrade")
    list_parser = commands.add_parser("list", help="list catalogue packages and installation state")
    list_parser.add_argument("--installed", action="store_true", help="show only installed packages")
    list_parser.add_argument(
        "--platform", action="append", choices=[item.value for item in PLATFORMS],
        help="target platform; repeat to select several (default: both)",
    )
    list_parser.add_argument(
        "--scope", choices=("project", "user"), default="project",
        help="installation scope (default: project)",
    )
    list_parser.add_argument("--root", type=Path, default=argparse.SUPPRESS, help="project root (default: current directory)")
    list_parser.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    list_parser.set_defaults(operation="list")
    info = commands.add_parser("info", help="show package details")
    info.add_argument("packages", nargs="+", metavar="PACKAGE")
    info.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    info.set_defaults(operation="info")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raw_args = list(sys.argv[1:] if argv is None else argv)
    args = None
    try:
        args = build_parser().parse_args(raw_args)
        if args.command is not None:
            return run_installer_command(args)
        if args.local is not None or args.root is not None:
            return catalogue_menu(local=args.local, root=args.root)
        return catalogue_menu()
    except UsageError as exc:
        if "--json" in raw_args:
            command = getattr(args, "operation", None) if args is not None else None
            if command is None and raw_args:
                command = {
                    "remove": "uninstall",
                    "update": "upgrade",
                }.get(raw_args[0], raw_args[0])
            print(json.dumps({
                "schemaVersion": 1,
                "command": command,
                "ok": False,
                "error": {"type": "usage", "message": str(exc)},
            }, ensure_ascii=False, sort_keys=True))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 2
    except (InstallError, ManifestError, ValueError) as exc:
        if "--json" in raw_args:
            print(json.dumps({
                "schemaVersion": 1,
                "command": getattr(args, "operation", args.command if args is not None else None),
                "ok": False,
                "error": {"type": "operation", "message": str(exc)},
            }, ensure_ascii=False, sort_keys=True))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
