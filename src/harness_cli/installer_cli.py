"""Non-interactive command surface for the catalogue installer."""

from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path

from harness_cli.catalogue import ResolvedPackage
from harness_cli.installer import (
    CatalogueInstaller,
    Change,
    InstallError,
    Target,
    UnownedFileError,
    UnownedHostProductError,
    installed_packages,
    reconcile_targets,
)
from harness_cli.git_warnings import symlink_worktree_warning
from harness_cli.manifest import ManifestError, SupportStatus, Tool, discover
from harness_cli.platforms import AVAILABLE_PLATFORMS, DEFAULT_PLATFORMS, Platform
from harness_cli.receipts import ReceiptStore, installation_lock, package_ownership


SCHEMA_VERSION = 1
PLATFORMS = AVAILABLE_PLATFORMS


class UsageError(Exception):
    """The requested operation is ambiguous or internally contradictory."""


def _selected_platforms(args: Namespace) -> tuple[Platform, ...]:
    selected = args.platform or [platform.value for platform in DEFAULT_PLATFORMS]
    return tuple(Platform.parse(value) for value in dict.fromkeys(selected))


def _targets(args: Namespace, platforms: tuple[Platform, ...]) -> list[Target]:
    if args.scope == "user":
        if args.root is not None:
            raise UsageError("--root cannot be used with --scope user")
        return [Target.for_user(platform) for platform in platforms]
    root = Path(args.root).expanduser() if args.root is not None else Path.cwd()
    if not root.is_dir():
        raise UsageError(f"project root is not an existing directory: {root}")
    return [Target.for_project(root, platform) for platform in platforms]


def _change(change: Change) -> dict[str, str]:
    return {"action": change.action, "package": change.package, "reason": change.reason}


def _summary(results: list[dict]) -> dict[str, int]:
    return {
        "targets": len(results),
        "changedTargets": sum(result["status"] == "changed" for result in results),
        "unchangedTargets": sum(result["status"] == "unchanged" for result in results),
        "failedTargets": sum(result["status"] == "failed" for result in results),
        "changes": sum(len(result["changes"]) for result in results),
        "skipped": sum(len(result["skipped"]) for result in results),
    }


def _emit(payload: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    for result in payload["results"]:
        print(f"{payload['scope'].title()} · {result['product']}")
        if result["status"] == "failed":
            print(f"  failed: {result['error']}")
            continue
        for change in result["changes"]:
            reason = f" ({change['reason']})" if change["reason"] else ""
            print(f"  {change['action']} {change['package']}{reason}")
        for skipped in result["skipped"]:
            print(f"  skip {skipped['package']} ({skipped['reason']})")
        if not result["changes"] and not result["skipped"]:
            print("  already up to date")


def _apply(
    planned: list[tuple[CatalogueInstaller, set[str], dict]],
    dry_run: bool,
    overwrite: bool = False,
    adopt: bool = False,
) -> bool:
    if dry_run:
        return True
    try:
        approved = (
            [path for installer, selected, _ in planned for path in installer.conflicts(selected)]
            if overwrite
            else []
        )
        adopted = (
            {
                name
                for installer, selected, _ in planned
                for name in installer.unowned_host_products(selected)
            }
            if adopt
            else set()
        )
        reconcile_targets(
            [(installer, selected) for installer, selected, _ in planned],
            overwrite=approved,
            adopt=adopted,
        )
    except UnownedFileError as exc:
        replace = "it" if len(exc.paths) == 1 else "them"
        message = f"{exc}; rerun with --overwrite to replace {replace}"
        for _, _, result in planned:
            result["status"] = "failed"
            result["error"] = message
        return False
    except UnownedHostProductError as exc:
        take = "it" if len(exc.products) == 1 else "them"
        message = f"{exc}; rerun with --adopt to take ownership of {take}"
        for _, _, result in planned:
            result["status"] = "failed"
            result["error"] = message
        return False
    except (InstallError, ManifestError, ValueError) as exc:
        for _, _, result in planned:
            result["status"] = "failed"
            result["error"] = str(exc)
        return False
    return True


def _validate_selectable(names: set[str], available: dict[str, Tool]) -> None:
    unknown = sorted(name for name in names if name not in available or not available[name].selectable)
    if unknown:
        raise InstallError("unknown catalogue package(s): " + ", ".join(unknown))


def _warn_for_symlink_worktree(
    installer: CatalogueInstaller, resolved: list[ResolvedPackage]
) -> None:
    target = installer.target
    if (
        target.platform is Platform.CLAUDE
        and not target.is_user
        and installer.skill_mode == "symlink"
        and any(payload.root == "skills" for item in resolved for payload in installer._payloads(item.tool))
        and (warning := symlink_worktree_warning(target.scope_root))
    ):
        print(f"warning: {warning}", file=sys.stderr)


def run_install(args: Namespace) -> int:
    available = discover(local=args.local) if getattr(args, "local", None) is not None else discover()
    requested = set(args.packages)
    if args.all and requested:
        raise UsageError("--all cannot be combined with package names")
    if not args.all and not requested:
        raise UsageError("specify package names or use --all")
    if args.all:
        requested = {name for name, tool in available.items() if tool.selectable}
    _validate_selectable(requested, available)
    platforms = _selected_platforms(args)
    targets = _targets(args, platforms)
    store = ReceiptStore.load()
    planned: list[tuple[CatalogueInstaller, set[str], dict]] = []

    for target in targets:
        roots = {
            name
            for name, receipt in installed_packages(target, store).items()
            if package_ownership(receipt) in {"selected", "retained"}
        }
        compatible_requested = {
            name
            for name in requested
            if available[name].support_for(target.platform).status is SupportStatus.SUPPORTED
        }
        selected = roots | compatible_requested
        skipped = [
            {
                "package": name,
                "reason": available[name].support_for(target.platform).reason
                or available[name].support_for(target.platform).status.value,
            }
            for name in sorted(requested - compatible_requested)
        ]
        installer = CatalogueInstaller(available, target, store, skill_mode=args.skill_mode)
        installer.update_packages = compatible_requested
        resolved, changes = installer.plan(selected)
        _warn_for_symlink_worktree(installer, resolved)
        result = {
            "platform": target.platform.value,
            "product": target.adapter.product_name,
            "status": "changed" if changes else "unchanged",
            "changes": [_change(change) for change in changes],
            "skipped": skipped,
        }
        planned.append((installer, selected, result))

    if requested and all(
        all(item["package"] in requested for item in result["skipped"])
        and requested <= {item["package"] for item in result["skipped"]}
        for _, _, result in planned
    ):
        raise InstallError("none of the requested packages support the selected platforms")

    ok = _apply(planned, args.dry_run, args.overwrite, args.adopt)

    results = [result for _, _, result in planned]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "command": "install",
        "ok": ok,
        "scope": args.scope,
        "root": str(targets[0].scope_root),
        "platforms": [platform.value for platform in platforms],
        "dryRun": args.dry_run,
        "results": results,
        "summary": _summary(results),
    }
    _emit(payload, args.json)
    return 0 if ok else 1


def run_uninstall(args: Namespace) -> int:
    requested = set(args.packages)
    if args.all and requested:
        raise UsageError("--all cannot be combined with package names")
    if not args.all and not requested:
        raise UsageError("specify package names or use --all")

    available = discover(local=args.local) if getattr(args, "local", None) is not None else discover()
    platforms = _selected_platforms(args)
    targets = _targets(args, platforms)
    store = ReceiptStore.load()
    receipts = {
        target.platform: installed_packages(target, store)
        for target in targets
    }
    unknown = requested - available.keys()
    installed_names = {
        name
        for packages in receipts.values()
        for name in packages
    }
    if missing := sorted(unknown - installed_names):
        raise InstallError("unknown catalogue package(s): " + ", ".join(missing))
    planned: list[tuple[CatalogueInstaller, set[str], dict]] = []
    for target in targets:
        roots = {
            name
            for name, receipt in receipts[target.platform].items()
            if package_ownership(receipt) in {"selected", "retained"}
        }
        selected = set() if args.all else roots - requested
        skipped = [
            {"package": name, "reason": "not installed as a selection"}
            for name in sorted(requested - roots)
        ]
        installer = CatalogueInstaller(available, target, store)
        installer.update_packages = set()
        _, changes = installer.plan(selected)
        result = {
            "platform": target.platform.value,
            "product": target.adapter.product_name,
            "status": "changed" if changes else "unchanged",
            "changes": [_change(change) for change in changes],
            "skipped": skipped,
        }
        planned.append((installer, selected, result))

    ok = _apply(planned, args.dry_run)

    results = [result for _, _, result in planned]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "command": "uninstall",
        "ok": ok,
        "scope": args.scope,
        "root": str(targets[0].scope_root),
        "platforms": [platform.value for platform in platforms],
        "dryRun": args.dry_run,
        "results": results,
        "summary": _summary(results),
    }
    _emit(payload, args.json)
    return 0 if ok else 1


def run_upgrade(args: Namespace) -> int:
    available = discover(local=args.local) if getattr(args, "local", None) is not None else discover()
    platforms = _selected_platforms(args)
    targets = _targets(args, platforms)
    store = ReceiptStore.load()
    planned: list[tuple[CatalogueInstaller, set[str], dict]] = []
    for target in targets:
        roots = {
            name
            for name, receipt in installed_packages(target, store).items()
            if package_ownership(receipt) in {"selected", "retained"}
        }
        selected = roots
        skipped = []
        installer = CatalogueInstaller(available, target, store, skill_mode=args.skill_mode)
        resolved, changes = installer.plan(selected)
        _warn_for_symlink_worktree(installer, resolved)
        result = {
            "platform": target.platform.value,
            "product": target.adapter.product_name,
            "status": "changed" if changes else "unchanged",
            "changes": [_change(change) for change in changes],
            "skipped": skipped,
        }
        planned.append((installer, selected, result))

    ok = _apply(planned, args.dry_run, args.overwrite, args.adopt)

    results = [result for _, _, result in planned]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "command": "upgrade",
        "ok": ok,
        "scope": args.scope,
        "root": str(targets[0].scope_root),
        "platforms": [platform.value for platform in platforms],
        "dryRun": args.dry_run,
        "results": results,
        "summary": _summary(results),
    }
    _emit(payload, args.json)
    return 0 if ok else 1


def _support(tool: Tool, platforms: tuple[Platform, ...]) -> dict[str, dict[str, str]]:
    result = {}
    for platform in platforms:
        support = tool.support_for(platform)
        details = {"status": support.status.value}
        if support.reason:
            details["reason"] = support.reason
        if support.replacement:
            details["replacement"] = support.replacement
        result[platform.value] = details
    return result


def run_list(args: Namespace) -> int:
    available = discover(local=args.local) if getattr(args, "local", None) is not None else discover()
    platforms = _selected_platforms(args)
    targets = _targets(args, platforms)
    store = ReceiptStore.load()
    receipts = {
        target.platform: installed_packages(target, store)
        for target in targets
    }
    packages = []
    candidates = available.values() if args.installed else (
        item for item in available.values() if item.selectable
    )
    for tool in sorted(
        candidates,
        key=lambda item: (item.root.parent.name, item.name),
    ):
        installed = [
            {
                "platform": platform.value,
                "version": receipt["version"],
                "ownership": package_ownership(receipt),
            }
            for platform in platforms
            if (receipt := receipts[platform].get(tool.name)) is not None
        ]
        if args.installed and not installed:
            continue
        packages.append(
            {
                "name": tool.name,
                "available": True,
                "version": tool.version,
                "description": tool.description,
                "category": tool.root.parent.name,
                "docs": tool.docs,
                "support": _support(tool, platforms),
                "installed": installed,
            }
        )

    unavailable = sorted(
        {
            name
            for packages_for_platform in receipts.values()
            for name in packages_for_platform
        }
        - available.keys()
    )
    for name in unavailable:
        packages.append(
            {
                "name": name,
                "available": False,
                "installed": [
                    {
                        "platform": platform.value,
                        "version": receipt["version"],
                        "ownership": package_ownership(receipt),
                    }
                    for platform in platforms
                    if (receipt := receipts[platform].get(name)) is not None
                ],
            }
        )

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "command": "list",
        "ok": True,
        "scope": args.scope,
        "root": str(targets[0].scope_root),
        "platforms": [platform.value for platform in platforms],
        "packages": packages,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    elif not packages:
        print("No packages match.")
    else:
        for package in packages:
            states = ", ".join(
                f"{item['platform']}: {item['ownership']}@{item['version']}"
                for item in package["installed"]
            ) or "not installed"
            if package["available"]:
                print(f"{package['name']} {package['version']} [{states}] - {package['description']}")
            else:
                print(f"{package['name']} [{states}] - not in pinned catalogue")
    return 0


def run_info(args: Namespace) -> int:
    available = discover(local=args.local) if getattr(args, "local", None) is not None else discover()
    requested = set(args.packages)
    unknown = sorted(requested - available.keys())
    if unknown:
        raise InstallError("unknown catalogue package(s): " + ", ".join(unknown))
    packages = []
    for name in args.packages:
        tool = available[name]
        packages.append(
            {
                "name": tool.name,
                "version": tool.version,
                "description": tool.description,
                "category": tool.root.parent.name,
                "docs": tool.docs,
                "selectable": tool.selectable,
                "platforms": _support(tool, PLATFORMS),
                "dependencies": [
                    {
                        "name": dependency.name,
                        "constraint": dependency.constraint,
                        "lifecycle": dependency.lifecycle,
                    }
                    for dependency in tool.dependencies
                ],
                "requires": list(tool.requires),
                "actions": [action.type for action in tool.actions],
            }
        )
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "command": "info",
        "ok": True,
        "packages": packages,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        for index, package in enumerate(packages):
            if index:
                print()
            print(f"{package['name']} {package['version']}")
            print(f"  {package['description']}")
            print(f"  Category: {package['category']}")
            if package["dependencies"]:
                dependencies = ", ".join(
                    item["name"] + item["constraint"] for item in package["dependencies"]
                )
                print(f"  Dependencies: {dependencies}")
            support = ", ".join(
                f"{platform}: {details['status']}"
                for platform, details in package["platforms"].items()
            )
            print(f"  Platforms: {support}")
            if package["docs"]:
                print(f"  Docs: {package['docs']}")
    return 0


def run(args: Namespace) -> int:
    if args.operation == "install":
        if args.dry_run:
            return run_install(args)
        with installation_lock():
            return run_install(args)
    if args.operation == "uninstall":
        if args.dry_run:
            return run_uninstall(args)
        with installation_lock():
            return run_uninstall(args)
    if args.operation == "upgrade":
        if args.dry_run:
            return run_upgrade(args)
        with installation_lock():
            return run_upgrade(args)
    if args.operation == "list":
        return run_list(args)
    if args.operation == "info":
        return run_info(args)
    raise InstallError(f"unsupported installer command '{args.operation}'")
