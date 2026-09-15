"""Clean-slate catalogue reconciliation with durable ownership receipts."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import tempfile
from copy import deepcopy
from dataclasses import dataclass, replace
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from harness_cli import gitignore, settings_merge
from harness_cli.catalogue import CatalogueError, ResolvedPackage, resolve_dependencies
from harness_cli.host_actions import HostActionError, PreparedAction, apply as apply_host_action
from harness_cli.host_actions import prepare as prepare_host_action
from harness_cli.host_actions import describe as describe_host_action
from harness_cli.host_actions import is_installed as host_action_is_installed
from harness_cli.host_actions import uninstall as uninstall_host_action
from harness_cli.manifest import ExpandedFile, HostAction, SupportStatus, Tool
from harness_cli.platforms import Platform, PlatformAdapter, get_adapter
from harness_cli.receipts import ReceiptStore, package_ownership


class InstallError(Exception):
    pass


class UnownedFileError(InstallError):
    """Installing would replace existing files no receipt accounts for."""

    def __init__(self, paths: Sequence[Path]):
        self.paths = tuple(paths)
        listed = ", ".join(str(path) for path in self.paths)
        noun = "file" if len(self.paths) == 1 else "files"
        super().__init__(f"refusing to overwrite unowned {noun} {listed}")


class UnownedHostProductError(InstallError):
    """Installing would take over host products no receipt accounts for."""

    def __init__(self, products: Sequence[str]):
        self.products = tuple(products)
        listed = ", ".join(self.products)
        noun = "product" if len(self.products) == 1 else "products"
        super().__init__(f"refusing to take over unowned host {noun} {listed}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical_path(path: Path | str) -> str:
    return os.path.normcase(str(Path(path).resolve()))


@dataclass(frozen=True)
class Target:
    scope_root: Path
    adapter: PlatformAdapter
    is_user: bool = False

    @classmethod
    def for_project(cls, root: Path, platform: Platform | str = Platform.CLAUDE) -> "Target":
        return cls(root.resolve(), get_adapter(platform))

    @classmethod
    def for_user(cls, platform: Platform | str = Platform.CLAUDE) -> "Target":
        return cls(Path.home().resolve(), get_adapter(platform), True)

    @property
    def platform(self) -> Platform:
        return self.adapter.platform

    @property
    def install_root(self) -> Path:
        return self.adapter.platform_root(self.scope_root, self.is_user)

    @property
    def settings_path(self) -> Path:
        return self.adapter.config_path(self.scope_root, self.is_user, False)

    @property
    def gitignore_path(self) -> Path:
        return self.install_root / ".gitignore" if self.is_user else self.scope_root / ".gitignore"

    def destination_path(self, root: str, dest: str) -> Path:
        destination_root = self.adapter.destination_root(self.scope_root, self.is_user, root)
        if destination_root.is_symlink():
            raise InstallError(f"refusing to install through symlinked directory {destination_root}")
        path = destination_root / dest
        resolved_root = destination_root.resolve()
        resolved_path = path.resolve(strict=False)
        if resolved_path != resolved_root and resolved_root not in resolved_path.parents:
            raise InstallError(f"destination escapes installation root: {path}")
        current = path
        while current != destination_root:
            if current.is_symlink():
                raise InstallError(f"refusing to install through symlink {current}")
            current = current.parent
        return path

    def read_settings(self) -> dict[str, Any]:
        if not self.settings_path.is_file():
            return {}
        try:
            value = json.loads(self.settings_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise InstallError(f"{self.settings_path} is not valid JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise InstallError(f"{self.settings_path} must contain a JSON object")
        return value


def _python_command() -> tuple[str, list[str]] | None:
    if shutil.which("uv"):
        return "uv", ["run", "--no-project", "--no-managed-python"]
    for name in ("python3", "python", "py"):
        if executable := shutil.which(name):
            try:
                result = subprocess.run(
                    [executable, "-c", "import sys; raise SystemExit(sys.version_info[0] != 3)"],
                    capture_output=True,
                    timeout=10,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0:
                return executable, []
    return None


def _substitute(value: Any, target: Target, python: tuple[str, list[str]] | None = None) -> Any:
    if isinstance(value, str):
        for placeholder, replacement in target.adapter.placeholders(target.scope_root, target.is_user).items():
            value = value.replace(placeholder, replacement)
        if "${PYTHON}" in value:
            if python is None:
                raise InstallError("this package requires Python 3 or uv on PATH")
            command = [python[0], *python[1]]
            launcher = subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)
            value = value.replace("${PYTHON}", launcher)
        return value
    if isinstance(value, list):
        return [_substitute(item, target, python) for item in value]
    if isinstance(value, dict):
        if value.get("type") == "command" and value.get("command") == "${PYTHON}":
            if python is None:
                raise InstallError("this package requires Python 3 or uv on PATH")
            return {
                **{key: _substitute(item, target, python) for key, item in value.items() if key not in {"command", "args"}},
                "command": python[0],
                "args": [*python[1], *[_substitute(item, target, python) for item in value.get("args", [])]],
            }
        return {key: _substitute(item, target, python) for key, item in value.items()}
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    if path.is_symlink():
        raise InstallError(f"refusing to replace symlink {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.harness-{os.getpid()}-{next(tempfile._get_candidate_names())}")
    try:
        temporary.write_text(settings_merge.dumps(value), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.harness-{os.getpid()}-{next(tempfile._get_candidate_names())}"
    )
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _make_executable(path: Path) -> None:
    if os.name != "nt":
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _prepare_actions(actions: list[HostAction]) -> list[PreparedAction]:
    prepared: list[PreparedAction] = []
    try:
        for action in actions:
            prepared.append(prepare_host_action(action))
        return prepared
    except Exception:
        for action in prepared:
            action.cleanup()
        raise


def _prepare_rollback_actions(actions: list[HostAction]) -> list[PreparedAction | None]:
    """Fetch undo artifacts for receipt actions without demanding success.

    A receipt pins the artifact that was installed earlier, and a pinned release
    can be withdrawn.  Being unable to restore that artifact narrows the undo we
    can offer; it must never stop a removal or an upgrade from proceeding.
    """
    prepared: list[PreparedAction | None] = []
    for action in actions:
        try:
            prepared.append(prepare_host_action(action))
        except (OSError, HostActionError):
            prepared.append(None)
    return prepared


@dataclass(frozen=True)
class Change:
    action: str
    package: str
    reason: str = ""


@dataclass(frozen=True)
class _FileSnapshot:
    path: Path
    content: bytes | None
    mode: int | None


class _LocalTransaction:
    """Restore installer-owned local state if reconciliation does not commit."""

    def __init__(self, paths: set[Path], store: ReceiptStore):
        self._store = store
        self._store_data = deepcopy(store.data)
        paths = {path.absolute() for path in paths | {store.path}}
        for path in paths:
            current = path
            while True:
                if current.is_symlink():
                    raise OSError(f"refusing to snapshot symlinked path {current}")
                if current.parent == current:
                    break
                current = current.parent
        self._files = [
            _FileSnapshot(
                path,
                path.read_bytes() if path.is_file() else None,
                stat.S_IMODE(path.stat().st_mode) if path.is_file() else None,
            )
            for path in sorted(paths, key=lambda item: str(item))
        ]
        self._missing_directories = {
            parent
            for path in paths
            for parent in path.parents
            if not parent.exists()
        }

    def rollback(self) -> None:
        errors: list[str] = []
        for snapshot in self._files:
            try:
                if snapshot.content is None:
                    snapshot.path.unlink(missing_ok=True)
                    continue
                snapshot.path.parent.mkdir(parents=True, exist_ok=True)
                snapshot.path.write_bytes(snapshot.content)
                if snapshot.mode is not None:
                    snapshot.path.chmod(snapshot.mode)
            except OSError as exc:
                errors.append(str(exc))
        for directory in sorted(self._missing_directories, key=lambda item: len(item.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        self._store.data = deepcopy(self._store_data)
        if errors:
            raise OSError("; ".join(errors))


class CatalogueInstaller:
    """Reconcile one target to a set of selected or retained root packages."""

    def __init__(self, available: dict[str, Tool], target: Target, store: ReceiptStore | None = None):
        self.available = available
        self.target = target
        self.store = store or ReceiptStore.load()

    @property
    def installation(self) -> dict[str, Any]:
        return self.store.installation(self.target.scope_root, self.target.platform.value, create=True)

    def _payloads(self, tool: Tool) -> list[ExpandedFile]:
        scope = "user" if self.target.is_user else "project"
        return tool.expand(self.target.platform, scope)

    def explicit_packages(self) -> set[str]:
        return {
            name
            for name, receipt in self.installation["packages"].items()
            if package_ownership(receipt) in {"selected", "retained"}
        }

    def _owned_in_another_installation(self, name: str) -> bool:
        current = self.installation
        return any(
            installation is not current and name in installation.get("packages", {})
            for installation in self.store.data["installations"].values()
        )

    def _file_owned_in_another_installation(self, path: str) -> bool:
        canonical = _canonical_path(path)
        current = self.installation
        return any(
            installation is not current
            and any(
                record.get("owned")
                and _canonical_path(record["path"]) == canonical
                for receipt in installation.get("packages", {}).values()
                for record in receipt.get("files", [])
            )
            for installation in self.store.data["installations"].values()
        )

    def _validate_receipt_paths(self, packages: dict[str, Any]) -> None:
        """Reject receipt paths that could make an operation touch elsewhere."""
        root = self.target.scope_root.resolve()
        for package, receipt in packages.items():
            for record in receipt.get("files", []):
                path = Path(record["path"])
                try:
                    resolved = path.resolve(strict=False)
                except OSError as exc:
                    raise InstallError(f"cannot resolve receipt path for {package}: {path}") from exc
                if resolved != root and root not in resolved.parents:
                    raise InstallError(f"receipt path for {package} escapes target root: {path}")

    @staticmethod
    def _removal_order(packages: dict[str, Any], desired: set[str]) -> list[str]:
        remaining = {name for name in packages if name not in desired}
        order: list[str] = []
        while remaining:
            removable = sorted(
                name
                for name in remaining
                if not any(
                    name in packages[other].get("dependencies", [])
                    for other in remaining
                    if other != name
                )
            )
            if not removable:
                raise InstallError("installed receipt graph contains a dependency cycle")
            order.extend(removable)
            remaining.difference_update(removable)
        return order

    def plan(self, requested_names: set[str]) -> tuple[list[ResolvedPackage], list[Change]]:
        missing = sorted(requested_names - self.available.keys())
        if missing:
            raise InstallError(f"unknown catalogue package(s): {', '.join(missing)}")
        try:
            resolved = resolve_dependencies([self.available[name] for name in sorted(requested_names)], self.available)
        except CatalogueError as exc:
            raise InstallError(str(exc)) from exc
        desired = {item.tool.name: item for item in resolved}
        current = self.installation["packages"]
        self._validate_receipt_paths(current)
        retained = {
            name
            for name in requested_names
            if name in current and package_ownership(current[name]) == "retained"
        }
        newly_retained: set[str] = set()
        removal_candidates = self._removal_order(current, set(desired))

        def is_coupled(parent: str, dependency: str) -> bool:
            recorded = current[parent].get("coupledDependencies")
            if isinstance(recorded, list):
                return dependency in recorded
            tool = self.available.get(parent)
            return bool(
                tool
                and any(
                    item.name == dependency and item.lifecycle == "coupled"
                    for item in tool.dependencies
                )
            )

        for name in removal_candidates:
            receipt = current[name]
            if name in desired or package_ownership(receipt) != "dependency" or name not in self.available:
                continue
            parents = [
                parent
                for parent, parent_receipt in current.items()
                if name in parent_receipt.get("dependencies", [])
            ]
            if not parents or any(not is_coupled(parent, name) for parent in parents):
                newly_retained.add(name)
                retained.add(name)
            if name in newly_retained:
                resolved = resolve_dependencies(
                    [self.available[name] for name in sorted(requested_names | retained)],
                    self.available,
                )
                desired = {item.tool.name: item for item in resolved}
        resolved = [
            replace(
                item,
                ownership=(
                    "retained"
                    if item.tool.name in retained
                    else "selected"
                    if item.tool.name in requested_names
                    else "dependency"
                ),
            )
            for item in resolved
        ]
        desired = {item.tool.name: item for item in resolved}
        for item in resolved:
            support = item.tool.support_for(self.target.platform)
            if support.status is not SupportStatus.SUPPORTED:
                raise InstallError(
                    f"{item.tool.name} is {support.status.value} for {self.target.adapter.product_name}"
                )
        changes = [Change("retain", name) for name in sorted(newly_retained)]
        changes.extend(Change("remove", name) for name in self._removal_order(current, set(desired)))
        for item in resolved:
            receipt = current.get(item.tool.name)
            if receipt is None:
                changes.append(Change("install", item.tool.name, "selected" if item.explicit else "dependency"))
            elif receipt.get("version") != item.tool.version:
                changes.append(Change("upgrade", item.tool.name, f"{receipt.get('version')} -> {item.tool.version}"))
            elif (
                package_ownership(receipt) != item.ownership
                and item.tool.name not in newly_retained
            ):
                changes.append(Change("ownership", item.tool.name, item.ownership))
            elif any(
                record.get("owned") and not Path(record["path"]).is_file()
                for record in receipt.get("files", [])
            ):
                changes.append(Change("update", item.tool.name, "missing installed files"))
            elif self._missing_host_actions(item.tool):
                changes.append(Change("update", item.tool.name, "missing host product"))
        return resolved, changes

    @staticmethod
    def _missing_host_actions(tool: Tool) -> list[HostAction]:
        """List host products a receipt claims but the machine no longer has."""
        return [action for action in tool.actions if not host_action_is_installed(action)]

    def _local_paths(self, resolved: list[ResolvedPackage]) -> set[Path]:
        packages = self.installation["packages"]
        paths = {self.target.settings_path, self.target.gitignore_path}
        paths.update(
            Path(record["path"])
            for receipt in packages.values()
            for record in receipt.get("files", [])
        )
        paths.update(
            self.target.destination_path(payload.root, payload.dest)
            for item in resolved
            for payload in self._payloads(item.tool)
        )
        return paths

    def conflicts(self, requested_names: set[str]) -> list[Path]:
        """List existing files an install would replace without owning them."""

        resolved, _ = self.plan(requested_names)
        return self._audit_destinations(resolved, set())

    def unowned_host_products(self, requested_names: set[str]) -> dict[str, list[str]]:
        """Map each package to host products present that no receipt claims."""

        resolved, _ = self.plan(requested_names)
        return self._audit_host_products(resolved, set())

    def _audit_host_products(
        self, resolved: list[ResolvedPackage], adopted: set[str]
    ) -> dict[str, list[str]]:
        """Report host products an install would take over without owning.

        Only a package this installation has no receipt for can surprise us.
        A product another installation already owns is shared on purpose, and
        an upgrade keeps managing what its own receipt installed.
        """
        packages = self.installation["packages"]
        found: dict[str, list[str]] = {}
        for item in resolved:
            if (
                item.tool.name in adopted
                or packages.get(item.tool.name) is not None
                or self._owned_in_another_installation(item.tool.name)
            ):
                continue
            present = [
                describe_host_action(action)
                for action in item.tool.actions
                if host_action_is_installed(action)
            ]
            if present:
                found[item.tool.name] = present
        return found

    def _audit_destinations(self, resolved: list[ResolvedPackage], approved: set[str]) -> list[Path]:
        """Reject unsafe destinations and report the unowned files left to decide."""

        desired = {item.tool.name for item in resolved}
        packages = self.installation["packages"]
        claimed: dict[str, str] = {}
        current_installation = self.installation
        for installation in self.store.data["installations"].values():
            for owner, receipt in installation.get("packages", {}).items():
                if installation is current_installation and owner not in desired:
                    continue
                for file in receipt.get("files", []):
                    claimed[_canonical_path(file["path"])] = owner
        unowned: list[Path] = []
        for item in resolved:
            for payload in self._payloads(item.tool):
                path = str(self.target.destination_path(payload.root, payload.dest).resolve())
                path_key = _canonical_path(path)
                owner = claimed.get(path_key)
                if owner is not None and owner != item.tool.name:
                    raise InstallError(f"file collision: {item.tool.name} and {owner} both own {path}")
                claimed[path_key] = item.tool.name
                destination = Path(path)
                if not destination.exists():
                    continue
                receipt = packages.get(item.tool.name)
                owned = next(
                    (record for record in receipt.get("files", []) if _canonical_path(record["path"]) == path_key),
                    None,
                ) if receipt else None
                if owned is not None:
                    if (
                        receipt.get("version") != item.tool.version
                        and sha256(destination) != owned.get("digest")
                        and not payload.starter
                    ):
                        raise InstallError(
                            f"cannot safely upgrade {item.tool.name}; installed file was modified: {destination}"
                        )
                    if (
                        receipt.get("version") == item.tool.version
                        and owned.get("owned")
                        and sha256(destination) != owned.get("digest")
                        and not payload.starter
                    ):
                        raise InstallError(f"refusing to overwrite modified file {destination}")
                elif (
                    sha256(destination) != sha256(payload.source)
                    and not payload.starter
                    and path_key not in approved
                ):
                    unowned.append(destination)
        return unowned

    def reconcile(
        self,
        requested_names: set[str],
        *,
        overwrite: Iterable[Path] = (),
        adopt: Iterable[str] = (),
        _transaction: _LocalTransaction | None = None,
        _host_undo: list[tuple[str, HostAction | PreparedAction]] | None = None,
        _persist: bool = True,
        _deferred_cleanup: list[PreparedAction] | None = None,
    ) -> list[Change]:
        resolved, changes = self.plan(requested_names)
        approved = {_canonical_path(path) for path in overwrite}
        desired = {item.tool.name: item for item in resolved}
        packages = self.installation["packages"]
        if unowned := self._audit_destinations(resolved, approved):
            raise UnownedFileError(unowned)
        if products := self._audit_host_products(resolved, set(adopt)):
            raise UnownedHostProductError(
                [f"{text} ({name})" for name, texts in products.items() for text in texts]
            )

        prepared: dict[str, list[PreparedAction]] = {}
        rollback_prepared: dict[str, list[PreparedAction | None]] = {}
        host_undo = _host_undo if _host_undo is not None else []
        owns_transaction = _transaction is None
        transaction = _transaction
        if transaction is None:
            try:
                transaction = _LocalTransaction(self._local_paths(resolved), self.store)
            except OSError as exc:
                raise InstallError(str(exc)) from exc
        try:
            missing_requirements = sorted(
                {
                    requirement
                    for item in resolved
                    for requirement in item.tool.requires
                    if shutil.which(requirement) is None
                }
            )
            if missing_requirements:
                raise InstallError("missing required executable(s): " + ", ".join(missing_requirements))
            repairs: set[str] = set()
            for item in resolved:
                current = packages.get(item.tool.name)
                if current is not None and current.get("version") == item.tool.version:
                    missing_files = any(
                        record.get("owned") and not Path(record["path"]).is_file()
                        for record in current.get("files", [])
                    )
                    missing_actions = self._missing_host_actions(item.tool)
                    if missing_files or missing_actions:
                        repairs.add(item.tool.name)
                        prepared[item.tool.name] = _prepare_actions(missing_actions)
                if current is None or current.get("version") != item.tool.version:
                    shared_host_owner = current is None and self._owned_in_another_installation(item.tool.name)
                    prepared[item.tool.name] = (
                        [] if shared_host_owner else _prepare_actions(list(item.tool.actions))
                    )
                    if current is not None and current.get("version") != item.tool.version:
                        rollback_prepared[item.tool.name] = _prepare_rollback_actions(
                            [self._receipt_action(raw) for raw in current.get("actions", [])]
                        )
            for name in self._removal_order(packages, set(desired)):
                if not self._owned_in_another_installation(name):
                    rollback_prepared[name] = _prepare_rollback_actions(
                        [self._receipt_action(raw) for raw in packages[name].get("actions", [])]
                    )
            for name in self._removal_order(packages, set(desired)):
                self._remove(name, host_undo=host_undo, rollback_actions=rollback_prepared.get(name, []))
            for item in resolved:
                current = packages.get(item.tool.name)
                if current is None or current.get("version") != item.tool.version:
                    replacing = current is not None
                    if current is not None:
                        self._remove(item.tool.name, remove_actions=False)
                    self._install(
                        item,
                        prepared.get(item.tool.name, []),
                        host_undo,
                        rollback_prepared.get(item.tool.name, []) if replacing else [],
                        approved,
                    )
                elif item.tool.name in repairs:
                    self._install(item, prepared.get(item.tool.name, []), host_undo, [], approved)
                else:
                    current.pop("explicit", None)
                    current["ownership"] = item.ownership
                    current["dependencies"] = [dependency.name for dependency in item.tool.dependencies]
                    current["coupledDependencies"] = [
                        dependency.name
                        for dependency in item.tool.dependencies
                        if dependency.lifecycle == "coupled"
                    ]
            if _persist:
                if self.installation["packages"]:
                    self.store.save()
                else:
                    self.store.prune()
            return changes
        except Exception as exc:
            if not owns_transaction:
                raise
            rollback_errors = self._rollback(host_undo, transaction)
            detail = str(exc)
            if rollback_errors:
                detail += "; rollback also failed: " + "; ".join(rollback_errors)
            if isinstance(exc, InstallError) and not rollback_errors:
                raise
            raise InstallError(detail) from exc
        finally:
            actions = [
                action
                for group in [*prepared.values(), *rollback_prepared.values()]
                for action in group
                if action is not None
            ]
            if _deferred_cleanup is None:
                for action in actions:
                    action.cleanup()
            else:
                _deferred_cleanup.extend(actions)

    @staticmethod
    def _receipt_action(raw: dict[str, Any]) -> HostAction:
        return HostAction(raw["type"], {key: value for key, value in raw.items() if key != "type"})

    @staticmethod
    def _rollback(
        host_undo: list[tuple[str, HostAction | PreparedAction]],
        transaction: _LocalTransaction,
    ) -> list[str]:
        errors: list[str] = []
        for operation, action in reversed(host_undo):
            try:
                if operation == "uninstall":
                    assert isinstance(action, HostAction)
                    uninstall_host_action(action)
                else:
                    assert isinstance(action, PreparedAction)
                    apply_host_action(action)
            except (OSError, HostActionError) as exc:
                errors.append(str(exc))
        try:
            transaction.rollback()
        except OSError as exc:
            errors.append(str(exc))
        return errors

    def _install(
        self,
        item: ResolvedPackage,
        prepared: list[PreparedAction],
        host_undo: list[tuple[str, HostAction | PreparedAction]],
        previous_actions: list[PreparedAction | None],
        approved: set[str],
    ) -> None:
        tool = item.tool
        files: list[dict[str, Any]] = []
        prior_receipt = self.installation["packages"].get(tool.name)
        for payload in self._payloads(tool):
            destination = self.target.destination_path(payload.root, payload.dest)
            if destination.exists() and payload.starter:
                files.append({
                    "path": str(destination.resolve()),
                    "digest": sha256(destination),
                    "starter": True,
                    "owned": self._file_owned_in_another_installation(str(destination)),
                })
                continue
            if destination.exists() and sha256(destination) == sha256(payload.source):
                prior = next(
                    (
                        record
                        for record in (prior_receipt or {}).get("files", [])
                        if _canonical_path(record["path"]) == _canonical_path(destination)
                    ),
                    None,
                )
                files.append({
                    "path": str(destination.resolve()),
                    "digest": sha256(destination),
                    "starter": payload.starter,
                    "owned": bool(
                        (prior and prior.get("owned"))
                        or self._file_owned_in_another_installation(str(destination))
                    ),
                })
                continue
            if (
                destination.exists()
                and sha256(destination) != sha256(payload.source)
                and _canonical_path(destination) not in approved
            ):
                raise UnownedFileError([destination])
            destination.parent.mkdir(parents=True, exist_ok=True)
            _copy_atomic(payload.source, destination)
            if payload.executable:
                _make_executable(destination)
            files.append({
                "path": str(destination.resolve()),
                "digest": sha256(destination),
                "starter": payload.starter,
                "owned": True,
            })

        raw_fragment = tool.fragment_for(self.target.platform)
        python = _python_command() if "${PYTHON}" in json.dumps(raw_fragment) else None
        fragment = _substitute(raw_fragment, self.target, python)
        if fragment:
            before = self.target.read_settings()
            _write_json(self.target.settings_path, self.target.adapter.merge_config(before, fragment))
            fragment = settings_merge.additions(before, fragment)
        patterns = [entry if self.target.is_user else f"{self.target.adapter.project_platform_dir}/{entry}" for entry in tool.gitignore]
        if not self.target.is_user:
            patterns.extend(tool.workspace_gitignore)
        block = f"{tool.name}:{self.target.platform.value}"
        if patterns:
            if self.target.gitignore_path.is_symlink():
                raise InstallError(f"refusing to replace symlink {self.target.gitignore_path}")
            before = self.target.gitignore_path.read_text(encoding="utf-8") if self.target.gitignore_path.is_file() else ""
            self.target.gitignore_path.parent.mkdir(parents=True, exist_ok=True)
            updated = gitignore.apply(before, block, patterns)
            temporary = self.target.gitignore_path.with_name(
                f".{self.target.gitignore_path.name}.harness-{os.getpid()}-{next(tempfile._get_candidate_names())}"
            )
            try:
                temporary.write_text(updated, encoding="utf-8")
                os.replace(temporary, self.target.gitignore_path)
            finally:
                temporary.unlink(missing_ok=True)
        restorable = [previous for previous in previous_actions if previous is not None]
        restore_previous = bool(restorable)
        for action in prepared:
            apply_host_action(action)
            if restore_previous:
                host_undo.extend(("apply", previous) for previous in reversed(restorable))
                restore_previous = False
            host_undo.append(("uninstall", action.action))
        self.installation["packages"][tool.name] = {
            "version": tool.version,
            "ownership": item.ownership,
            "dependencies": [dependency.name for dependency in tool.dependencies],
            "coupledDependencies": [
                dependency.name
                for dependency in tool.dependencies
                if dependency.lifecycle == "coupled"
            ],
            "files": files,
            "fragment": fragment,
            "gitignoreBlock": block if patterns else None,
            "actions": [{"type": action.type, **action.data} for action in tool.actions],
        }

    def _remove(
        self,
        name: str,
        remove_actions: bool = True,
        host_undo: list[tuple[str, HostAction | PreparedAction]] | None = None,
        rollback_actions: list[PreparedAction | None] | None = None,
    ) -> None:
        receipt = self.installation["packages"].get(name)
        if receipt is None:
            return
        if remove_actions and not self._owned_in_another_installation(name):
            old_actions = rollback_actions or []
            for index, raw in reversed(list(enumerate(receipt.get("actions", [])))):
                uninstall_host_action(self._receipt_action(raw))
                restore = old_actions[index] if index < len(old_actions) else None
                if host_undo is not None and restore is not None:
                    host_undo.append(("apply", restore))
        for record in receipt.get("files", []):
            path = Path(record["path"])
            if (
                not self._file_owned_in_another_installation(record["path"])
                and record["owned"]
                and path.is_file()
                and sha256(path) == record.get("digest")
            ):
                path.unlink()
                current = path.parent
                while current != self.target.scope_root and self.target.scope_root in current.parents:
                    try:
                        current.rmdir()
                    except OSError:
                        break
                    current = current.parent
        fragment = receipt.get("fragment")
        if isinstance(fragment, dict) and fragment and self.target.settings_path.is_file():
            if self.target.settings_path.is_symlink():
                raise InstallError(f"refusing to modify symlink {self.target.settings_path}")
            shared: list[dict] = []
            for other_name, other_receipt in self.installation["packages"].items():
                if other_name == name:
                    continue
                other_fragment = other_receipt.get("fragment")
                tool = self.available.get(other_name)
                if tool is not None:
                    raw = tool.fragment_for(self.target.platform)
                    if raw:
                        try:
                            other_fragment = _substitute(raw, self.target, _python_command())
                        except InstallError:
                            # A peer's receipt is already resolved and remains the
                            # authoritative ownership record.  If its source can no
                            # longer be substituted (for example, uv disappeared),
                            # retain that receipt rather than making uninstall fail.
                            pass
                if isinstance(other_fragment, dict) and other_fragment:
                    shared.append(other_fragment)
            fragment = settings_merge.remove_shared(fragment, shared)
            if not fragment:
                fragment = None
        if isinstance(fragment, dict) and fragment and self.target.settings_path.is_file():
            # Leave the configuration file behind even once it holds nothing:
            # an empty config reads as "no hooks configured", where a vanished
            # one reads as a file the installer had no business deleting.
            _write_json(
                self.target.settings_path,
                self.target.adapter.unmerge_config(self.target.read_settings(), fragment),
            )
        block = receipt.get("gitignoreBlock")
        if isinstance(block, str) and self.target.gitignore_path.is_file():
            if self.target.gitignore_path.is_symlink():
                raise InstallError(f"refusing to modify symlink {self.target.gitignore_path}")
            after = gitignore.remove(self.target.gitignore_path.read_text(encoding="utf-8"), block)
            if after.strip():
                self.target.gitignore_path.write_text(after, encoding="utf-8")
            else:
                self.target.gitignore_path.unlink(missing_ok=True)
        del self.installation["packages"][name]

def reconcile_targets(
    requests: list[tuple[CatalogueInstaller, set[str]]],
    *,
    overwrite: Iterable[Path] = (),
    adopt: Iterable[str] = (),
) -> list[list[Change]]:
    """Reconcile several targets as one local and host-level transaction."""
    if not requests:
        return []
    store = requests[0][0].store
    if any(installer.store is not store for installer, _ in requests):
        raise InstallError("multi-target reconciliation requires one shared receipt store")

    local_paths: set[Path] = set()
    for installer, requested in requests:
        resolved, _ = installer.plan(requested)
        local_paths.update(installer._local_paths(resolved))
    try:
        transaction = _LocalTransaction(local_paths, store)
    except OSError as exc:
        raise InstallError(str(exc)) from exc

    host_undo: list[tuple[str, HostAction | PreparedAction]] = []
    cleanup: list[PreparedAction] = []
    try:
        changes = [
            installer.reconcile(
                requested,
                overwrite=overwrite,
                adopt=adopt,
                _transaction=transaction,
                _host_undo=host_undo,
                _persist=False,
                _deferred_cleanup=cleanup,
            )
            for installer, requested in requests
        ]
        store.prune()
        return changes
    except Exception as exc:
        rollback_errors = CatalogueInstaller._rollback(host_undo, transaction)
        detail = str(exc)
        if rollback_errors:
            detail += "; rollback also failed: " + "; ".join(rollback_errors)
        if isinstance(exc, InstallError) and not rollback_errors:
            raise
        raise InstallError(detail) from exc
    finally:
        for action in cleanup:
            action.cleanup()


def installed_packages(target: Target, store: ReceiptStore | None = None) -> dict[str, dict[str, Any]]:
    selected = store or ReceiptStore.load()
    return selected.installation(target.scope_root, target.platform.value).get("packages", {})
