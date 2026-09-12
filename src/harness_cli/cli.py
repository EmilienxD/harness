"""Ephemeral interactive catalogue installer."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from harness_cli import __version__
from harness_cli.installer import (
    CatalogueInstaller,
    Change,
    InstallError,
    Target,
    installed_packages,
)
from harness_cli.manifest import ManifestError, SupportStatus, Tool, discover
from harness_cli.platforms import Platform, get_adapter
from harness_cli.receipts import ReceiptStore
from harness_cli.tui import MenuOption, TerminalUI, terminal_keys


PLATFORMS = (Platform.CLAUDE, Platform.CHATGPT)


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


def _explicit_packages(targets: list[Target], store: ReceiptStore) -> set[str]:
    return {
        name
        for target in targets
        for name, receipt in installed_packages(target, store).items()
        if receipt.get("explicit")
    }


def _skip_line(tool: Tool, platform: Platform) -> str:
    support = tool.support_for(platform)
    product = get_adapter(platform).product_name
    if support.status is SupportStatus.REPLACEMENT:
        return f"    ○ {tool.name}: skipped for {product}. Alternative: {support.replacement}"
    reason = f" {support.reason}" if support.reason else ""
    return f"    ○ {tool.name}: skipped for {product}.{reason}"


_ACTION_MARKS = {
    "install": "+ install",
    "upgrade": "↑ upgrade",
    "remove": "- remove",
    "update": "~ update",
    "ownership": "~ ownership",
}


def _review_lines(
    tools: list[Tool],
    selected_names: set[str],
    targets: list[Target],
    changes_by_platform: dict[Platform, list[Change]],
) -> list[str]:
    scope = "Global" if targets[0].is_user else "Project"
    platforms = ", ".join(target.adapter.product_name for target in targets)
    lines = [f"  Install to  {scope}", f"  Platforms   {platforms}", ""]
    for target in targets:
        lines.append(f"  {target.adapter.product_name}")
        changes = changes_by_platform[target.platform]
        if not changes:
            lines.append("    ✓ Already up to date")
        grouped: dict[str, list[str]] = {}
        for change in changes:
            grouped.setdefault(_ACTION_MARKS.get(change.action, f"~ {change.action}"), []).append(
                change.package
            )
        for mark, packages in grouped.items():
            lines.append(f"    {mark} ({len(packages)})  {', '.join(sorted(packages))}")
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


def catalogue_menu() -> int:
    if not sys.stdin.isatty():
        raise InstallError("the catalogue is interactive; run `harness` in a terminal")
    available = discover()
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

        targets = _targets(scope, platforms)
        installed = _explicit_packages(targets, store)
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

        def apply_changes() -> None:
            for installer in installers:
                installer.reconcile(requests[installer.target.platform])

        ui.progress("Applying catalogue changes", "Catalogue updated", apply_changes)
        ui.outro("Done!  Review installed packages before use.")
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Install and reconcile the Harness catalogue.",
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    build_parser().parse_args(argv)
    try:
        return catalogue_menu()
    except (InstallError, ManifestError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
