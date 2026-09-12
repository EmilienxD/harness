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
from harness_cli.tui import MenuOption, PickerResult, TerminalUI, Toggle, terminal_keys


PLATFORM_CHOICES = (
    (Platform.CLAUDE, Platform.CHATGPT),
    (Platform.CLAUDE,),
    (Platform.CHATGPT,),
)
PLATFORM_LABELS = ("Claude + ChatGPT", "Claude Code only", "ChatGPT only")
SCOPE_LABELS = ("This project", "This user")


def _compatibility(tool: Tool) -> str:
    claude = tool.support_for(Platform.CLAUDE)
    chatgpt = tool.support_for(Platform.CHATGPT)
    if claude.status is SupportStatus.SUPPORTED and chatgpt.status is SupportStatus.SUPPORTED:
        return "Claude + ChatGPT"
    if claude.status is SupportStatus.SUPPORTED:
        if chatgpt.status is SupportStatus.REPLACEMENT:
            return f"Claude; ChatGPT alternative: {chatgpt.replacement}"
        return "Claude only"
    if chatgpt.status is SupportStatus.SUPPORTED:
        if claude.status is SupportStatus.REPLACEMENT:
            return f"ChatGPT; Claude alternative: {claude.replacement}"
        return "ChatGPT only"
    return "Unavailable"


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


def _tool_options(tools: list[Tool], installed: set[str]) -> list[MenuOption]:
    return [
        MenuOption(
            label=tool.name,
            detail=tool.description,
            group=_category(tool),
            badge=_compatibility(tool),
            installed=tool.name in installed,
        )
        for tool in tools
    ]


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
    scope = "This user" if targets[0].is_user else str(targets[0].scope_root)
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


def _pick(
    ui: TerminalUI, tools: list[Tool], selected: set[str], installed: set[str], scope: int, platform: int
) -> PickerResult:
    return ui.picker(
        "Harness catalogue",
        _tool_options(tools, installed),
        {index for index, tool in enumerate(tools) if tool.name in selected},
        (
            Toggle("p", "Install to", SCOPE_LABELS[scope], str(Path.cwd()) if scope == 0 else "Available across projects"),
            Toggle("t", "Platforms", PLATFORM_LABELS[platform], "Unsupported tools are skipped per platform"),
        ),
        confirm="Apply",
    )


def catalogue_menu() -> int:
    if not sys.stdin.isatty():
        raise InstallError("the catalogue is interactive; run `harness` in a terminal")
    available = discover()
    tools = sorted(available.values(), key=lambda tool: (_category_rank(tool), tool.name))
    store = ReceiptStore.load()
    scope = 0
    platform_index = 0
    selected_names: set[str] | None = None

    with terminal_keys() as read_key:
        ui = TerminalUI(read_key)
        while True:
            targets = _targets(scope, PLATFORM_CHOICES[platform_index])
            installed = _explicit_packages(targets, store)
            if selected_names is None:
                selected_names = set(installed)

            result = _pick(ui, tools, selected_names, installed, scope, platform_index)
            selected_names = {tools[index].name for index in result.selected}
            if result.action == "cancel":
                ui.message("Harness catalogue", ["Cancelled. No changes made."])
                return 0
            if result.action == "toggle":
                if result.toggle == 0:
                    scope = (scope + 1) % len(SCOPE_LABELS)
                else:
                    platform_index = (platform_index + 1) % len(PLATFORM_LABELS)
                continue

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
                ui.choose(
                    "No compatible tools",
                    (MenuOption("Go back", "Choose another platform or tool"),),
                    note="  None of the selected tools support this platform.",
                )
                continue

            changes_by_platform = {}
            for installer in installers:
                _, changes = installer.plan(requests[installer.target.platform])
                changes_by_platform[installer.target.platform] = changes
            if not any(changes_by_platform.values()):
                ui.message("Harness catalogue", ["  ✓ Catalogue already matches that selection.", ""])
                return 0
            review = _review_lines(tools, selected_names, targets, changes_by_platform)
            confirmation = ui.choose(
                "Review changes",
                (MenuOption("Apply", "Write these changes now"), MenuOption("Go back", "Keep editing the selection")),
                note="\n".join(review),
            )
            if confirmation is None or confirmation == 1:
                continue
            for installer in installers:
                installer.reconcile(requests[installer.target.platform])
            ui.message("Harness catalogue", ["  ✓ Catalogue updated.", ""])
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
