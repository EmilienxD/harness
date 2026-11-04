"""Resolve checkout runtimes and stage payloads that invoke them."""

from __future__ import annotations

import hashlib
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


RUNTIME_SOURCE = re.compile(
    r"git\+https://github\.com/EmilienxD/harness@[0-9a-fA-F]{40}"
    r"#subdirectory=[A-Za-z0-9_./-]+"
)


def runtime_path(checkout: Path, source: str) -> Path:
    subdirectory = parse_qs(urlsplit(source).fragment).get("subdirectory", [])
    if len(subdirectory) != 1:
        raise ValueError("local runtime requires a subdirectory")
    runtime = (checkout / subdirectory[0]).resolve()
    if checkout not in runtime.parents or not (runtime / "pyproject.toml").is_file():
        raise ValueError(f"invalid local runtime: {runtime}")
    return runtime


class PayloadOverrides:
    def __init__(self) -> None:
        self.sources: dict[Path, Path] = {}
        self.directory: tempfile.TemporaryDirectory | None = None
        self.digest = hashlib.sha256()

    def add(self, path: Path, root: Path, checkout: Path) -> None:
        if path in self.sources or path.suffix.lower() not in {".md", ".ts", ".py", ".json", ".toml"}:
            return
        content = path.read_text(encoding="utf-8")
        rewritten = RUNTIME_SOURCE.sub(lambda match: runtime_path(checkout, match[0]).as_uri(), content)
        if rewritten == content:
            return
        if self.directory is None:
            self.directory = tempfile.TemporaryDirectory(prefix="harness-local-payloads-")
        relative = path.relative_to(root)
        staged = Path(self.directory.name) / relative
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text(rewritten, encoding="utf-8", newline="")
        self.sources[path] = staged
        self.digest.update(relative.as_posix().encode("utf-8") + b"\0" + rewritten.encode("utf-8"))


def extension_fingerprint(source: Path) -> str:
    """Fingerprint build inputs, excluding generated output and dependencies."""
    digest = hashlib.sha256()
    inputs = [source / name for name in (
        "package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE",
    )]
    for directory in ("src", "assets", "scripts"):
        inputs.extend(sorted(path for path in (source / directory).rglob("*") if path.is_file()))
    for path in inputs:
        if path.is_file():
            digest.update(path.relative_to(source).as_posix().encode("utf-8") + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()
