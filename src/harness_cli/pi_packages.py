"""Locally supplied npm packages give Pi extensions a scope-independent identity.

Pi 1.2 identifies ordinary local packages by their absolute path. Named npm file
sources instead share an identity across scopes, without a registry dependency.
The package manifest points at receipt-owned entry points outside auto-discovery.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path
from urllib.parse import unquote

from harness_cli.manifest import ExpandedFile, Tool


def cache_path(archive: Path, receipt_path: Path) -> Path:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    return receipt_path.resolve().parent / "pi-packages" / f"{digest}.tgz"


def source(tool: Tool, archive: Path) -> str:
    # npm file specs can resolve from the launching cwd. A shared immutable
    # archive also remains available to copied worktrees after project removal.
    return f"npm:harness-pi-{tool.name}@file:{archive.as_posix()}"


def npm_metadata_paths(platform_root: Path) -> tuple[Path, ...]:
    prefix = platform_root / "npm"
    return tuple(prefix / name for name in (
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "node_modules/.package-lock.json",
    ))


def npm_removals(platform_root: Path, fragment: dict) -> dict[Path, dict]:
    """Remove only dependencies npm added for this receipt's local wrappers."""
    prefix = platform_root / "npm"
    manifest_path, *lock_paths = npm_metadata_paths(platform_root)
    if not manifest_path.is_file():
        return {}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    removed: set[str] = set()
    for entry in fragment.get("packages", []):
        value = entry.get("source") if isinstance(entry, dict) else entry
        if not isinstance(value, str) or not value.startswith("npm:harness-pi-") or "@file:" not in value:
            continue
        name, archive = value.removeprefix("npm:").split("@file:", 1)
        for section in ("dependencies", "devDependencies", "optionalDependencies"):
            dependencies = manifest.get(section, {})
            installed = dependencies.get(name)
            if (
                isinstance(installed, str) and installed.startswith("file:")
                and (prefix / unquote(installed[5:])).resolve() == Path(archive).resolve()
            ):
                del dependencies[name]
                if not dependencies:
                    manifest.pop(section, None)
                removed.add(name)
    if not removed:
        return {}
    changes = {manifest_path: manifest}
    for path in lock_paths:
        if not path.is_file():
            continue
        lock = json.loads(path.read_text(encoding="utf-8"))
        packages = lock.get("packages", {})
        for name in removed:
            packages.pop(f"node_modules/{name}", None)
            lock.get("dependencies", {}).pop(name, None)
            for section in ("dependencies", "devDependencies", "optionalDependencies"):
                packages.get("", {}).get(section, {}).pop(name, None)
        changes[path] = lock
    return changes


def payloads(tool: Tool, files: list[ExpandedFile], directory: Path) -> list[ExpandedFile]:
    entries = sorted({file.dest.split("/", 1)[0] for file in files if file.root == "extensions"})
    if not entries:
        return []
    manifest = {
        "name": f"harness-pi-{tool.name}", "version": tool.version, "private": True,
        "pi": {"extensions": [f"../../../extensions/{entry}" for entry in entries]},
    }
    content = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    directory.mkdir(parents=True, exist_ok=True)
    package_json = directory / "package.json"
    package_json.write_bytes(content)
    archive = directory / "package.tgz"
    with archive.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as tar:
            info = tarfile.TarInfo("package/package.json")
            info.size, info.mode = len(content), 0o644
            tar.addfile(info, io.BytesIO(content))
    return [
        ExpandedFile(package_json, f"npm/node_modules/harness-pi-{tool.name}/package.json", "platform", False, False),
        ExpandedFile(archive, f"harness/packages/{tool.name}.tgz", "platform", False, False),
    ]
