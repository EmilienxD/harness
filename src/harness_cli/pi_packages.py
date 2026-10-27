"""Complete local npm packages installed and removed by Pi's native CLI."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path
from collections.abc import Sequence

from harness_cli.manifest import ExpandedFile, Tool


class PiPackageError(RuntimeError):
    pass


def cache_path(archive: Path, receipt_path: Path) -> Path:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    return receipt_path.resolve().parent / "pi-packages" / f"{digest}.tgz"


def source(tool: Tool, archive: Path) -> str:
    return f"npm:harness-pi-{tool.name}@file:{archive.as_posix()}"


def package_root(platform_root: Path, name: str) -> Path:
    return platform_root / "npm" / "node_modules" / f"harness-pi-{name}"


def npm_metadata_paths(platform_root: Path) -> tuple[Path, ...]:
    return tuple(platform_root / "npm" / name for name in (
        "package.json", "package-lock.json", "npm-shrinkwrap.json", ".gitignore",
        "node_modules/.package-lock.json",
    ))


def command() -> list[str]:
    executable = shutil.which("pi")
    if not executable:
        raise PiPackageError("installing or removing Pi packages requires pi on PATH")
    if Path(executable).suffix.lower() in {".cmd", ".bat", ".ps1"}:
        cli = Path(executable).parent / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
        node = shutil.which("node")
        if not node or not cli.is_file():
            raise PiPackageError("could not locate node and Pi's CLI beside the Pi launcher")
        return [node, str(cli)]
    return [executable]


def run(operation: str, package_source: str, scope_root: Path, is_user: bool) -> None:
    env = {**os.environ, "npm_config_audit": "false", "npm_config_fund": "false"}
    if is_user:
        env["PI_CODING_AGENT_DIR"] = str(scope_root)
    scope_root.mkdir(parents=True, exist_ok=True)
    argv = [*command(), operation, package_source, *([] if is_user else ["--local", "--approve"])]
    try:
        result = subprocess.run(
            argv, cwd=scope_root, env=env, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PiPackageError(f"Pi package {operation} failed: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise PiPackageError(f"Pi package {operation} failed: {detail}")


def support_files(archive: Path, directory: Path) -> list[ExpandedFile]:
    """Reuse the selected installed dependency version, including its bundled helpers."""
    files = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.name.startswith("package/harness/") or not member.isfile():
                continue
            relative = member.name.removeprefix("package/harness/")
            destination = directory / relative
            if not destination.resolve().is_relative_to(directory.resolve()):
                raise PiPackageError("Pi dependency archive contains an unsafe path")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as content:
                destination.write_bytes(content.read())
            files.append(ExpandedFile(destination, relative, "support", bool(member.mode & 0o111), False))
    return files


def payloads(
    tool: Tool, files: list[ExpandedFile], directory: Path, dependencies: Sequence[ExpandedFile] = (),
) -> list[ExpandedFile]:
    """Stage a self-contained package while retaining workspace files outside npm storage."""
    bundled: dict[str, ExpandedFile] = {}
    for file in [*dependencies, *files]:
        if file.root == "workspace" and file.starter and file.dest.startswith(".harness/guards/"):
            bundled[f"harness/{Path(file.dest).name}"] = file
            continue
        if file.root not in {"extensions", "support", "skills"}:
            continue
        root = "harness" if file.root == "support" else file.root
        path = f"{root}/{file.dest}"
        previous = bundled.get(path)
        if previous and previous.source.read_bytes() != file.source.read_bytes():
            raise PiPackageError(f"conflicting Pi package payload: {path}")
        bundled[path] = file
    manifest = {
        "name": f"harness-pi-{tool.name}", "version": tool.version, "private": True,
        "type": "module", "keywords": ["pi-package"],
        "pi": {
            root: sorted({f"{root}/{file.dest.split('/', 1)[0]}" for file in files if file.root == root})
            for root in ("extensions", "skills")
        },
    }
    directory.mkdir(parents=True, exist_ok=True)
    package_json = directory / "package.json"
    package_json.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    bundled["package.json"] = ExpandedFile(package_json, "package.json", "platform", False, False)
    archive = directory / "package.tgz"
    with archive.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as tar:
            for name, file in sorted(bundled.items()):
                content = file.source.read_bytes()
                info = tarfile.TarInfo(f"package/{name}")
                info.size, info.mode = len(content), 0o755 if file.executable else 0o644
                tar.addfile(info, io.BytesIO(content))
    prefix = f"npm/node_modules/harness-pi-{tool.name}/"
    return [
        *[file for file in files if file.root == "workspace"],
        *[ExpandedFile(file.source, prefix + name, "platform", file.executable, False)
          for name, file in sorted(bundled.items())],
    ]
