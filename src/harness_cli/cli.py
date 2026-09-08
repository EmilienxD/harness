"""Harness: one catalogue menu and four standalone session commands."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from harness_cli import __version__
from harness_cli.installer import CatalogueInstaller, Change, InstallError, Target
from harness_cli.manifest import ManifestError, SupportStatus, Tool, discover
from harness_cli.platforms import Platform, get_adapter
from harness_cli.receipts import ReceiptStore
from harness_cli.sessions import SessionError, ask, launch, reply, resume
from harness_cli.tui import MenuOption, TerminalUI, terminal_keys


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


def _tool_options(tools: list[Tool]) -> list[MenuOption]:
    return [
        MenuOption(tool.name, f"{tool.description}  [{_compatibility(tool)}]")
        for tool in tools
    ]


def _targets(scope: int, platforms: tuple[Platform, ...]) -> list[Target]:
    if scope == 0:
        return [Target.for_project(Path.cwd(), platform) for platform in platforms]
    return [Target.for_user(platform) for platform in platforms]


def _skip_line(tool: Tool, platform: Platform) -> str:
    support = tool.support_for(platform)
    product = get_adapter(platform).product_name
    if support.status is SupportStatus.REPLACEMENT:
        return f"○ {tool.name}: skipped for {product}. Alternative: {support.replacement}"
    reason = f" {support.reason}" if support.reason else ""
    return f"○ {tool.name}: skipped for {product}.{reason}"


def _review_lines(
    tools: list[Tool],
    selected_names: set[str],
    targets: list[Target],
    changes_by_platform: dict[Platform, list[Change]],
) -> list[str]:
    scope = "this user" if targets[0].is_user else str(targets[0].scope_root)
    lines = [f"Scope: {scope}", "", "Compatibility:"]
    skips = [
        _skip_line(tool, target.platform)
        for target in targets
        for tool in tools
        if tool.name in selected_names
        and tool.support_for(target.platform).status is not SupportStatus.SUPPORTED
    ]
    lines.extend(skips or ["✓ Every selected tool supports every selected platform."])
    lines.extend(("", "Changes:"))
    for target in targets:
        lines.append(f"  {target.adapter.product_name}")
        changes = changes_by_platform[target.platform]
        if not changes:
            lines.append("    ✓ Already up to date")
        for action in ("install", "upgrade", "remove", "update"):
            matching = [change for change in changes if change.action == action]
            if not matching:
                continue
            packages = ", ".join(change.package for change in matching)
            lines.append(f"    {action.capitalize()} ({len(matching)}): {packages}")
        other = [
            change for change in changes
            if change.action not in {"install", "upgrade", "remove", "update"}
        ]
        if other:
            packages = ", ".join(change.package for change in other)
            lines.append(f"    Change ({len(other)}): {packages}")
    return lines


def catalogue_menu() -> int:
    if not sys.stdin.isatty():
        raise InstallError("the catalogue is interactive; run `harness` in a terminal")
    available = discover()
    tools = list(available.values())
    store = ReceiptStore.load()
    selected_indexes: set[int] = set()
    scope = 0
    platform_index = 0
    platform_choices = (
        (Platform.CLAUDE, Platform.CHATGPT),
        (Platform.CLAUDE,),
        (Platform.CHATGPT,),
    )

    with terminal_keys() as read_key:
        ui = TerminalUI(read_key)
        while True:
            picked = ui.checklist("Choose tools", _tool_options(tools), selected_indexes)
            if picked is None:
                ui.message("Harness catalogue", ["Cancelled. No changes made."])
                return 0
            selected_indexes = picked
            selected_names = {tools[index].name for index in selected_indexes}

            while True:
                picked_scope = ui.choose(
                    "Where should Harness install them?",
                    (
                        MenuOption("This project", str(Path.cwd())),
                        MenuOption("This user", "Available across projects"),
                    ),
                    scope,
                )
                if picked_scope is None:
                    break
                scope = picked_scope

                while True:
                    picked_platform = ui.choose(
                        "Which agent platforms?",
                        (
                            MenuOption("Claude + ChatGPT", "Recommended"),
                            MenuOption("Claude Code only"),
                            MenuOption("ChatGPT only"),
                        ),
                        platform_index,
                        "Unsupported tools will be skipped only for the incompatible platform.",
                    )
                    if picked_platform is None:
                        break
                    platform_index = picked_platform
                    targets = _targets(scope, platform_choices[platform_index])
                    installers = [CatalogueInstaller(available, target, store) for target in targets]
                    requests = {
                        target.platform: {
                            name
                            for name in selected_names
                            if available[name].support_for(target.platform).status
                            is SupportStatus.SUPPORTED
                        }
                        for target in targets
                    }
                    if selected_names and not any(requests.values()):
                        ui.choose(
                            "No compatible tools",
                            (MenuOption("Go back", "Choose another platform or tool"),),
                            note="None of the selected tools support this platform.",
                        )
                        continue

                    changes_by_platform = {}
                    for installer in installers:
                        _, changes = installer.plan(requests[installer.target.platform])
                        changes_by_platform[installer.target.platform] = changes
                    review = _review_lines(tools, selected_names, targets, changes_by_platform)
                    confirmation = ui.choose(
                        "Review installation",
                        (MenuOption("Apply changes"), MenuOption("Go back")),
                        note="\n".join(review),
                    )
                    if confirmation is None or confirmation == 1:
                        continue
                    if not any(changes_by_platform.values()):
                        ui.message("Harness catalogue", ["✓ Catalogue already matches that selection."])
                        return 0
                    for installer in installers:
                        installer.reconcile(requests[installer.target.platform])
                    ui.message("Harness catalogue", ["✓ Catalogue updated."])
                    return 0
                # Escape returns to the scope question.
                continue
            # Escape returns to the tool question.


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
