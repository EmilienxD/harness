"""Discovery and parsing of per-tool `harness.toml` manifests."""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


class ManifestError(Exception):
    """A manifest is missing, malformed, or points at files that don't exist."""


@dataclass(frozen=True)
class FileSpec:
    """One src -> dest copy instruction. `dest` is relative to the target `.claude/`.

    `starter` marks a file users are meant to edit after install (config
    templates, like the `.rules` files): it is copied when absent but never
    overwritten afterwards.
    """

    src: str
    dest: str
    executable: bool = False
    starter: bool = False


@dataclass(frozen=True)
class Tool:
    name: str
    version: str
    description: str
    root: Path
    files: tuple[FileSpec, ...]
    requires: tuple[str, ...] = ()
    gitignore: tuple[str, ...] = ()
    fragment: dict = field(default_factory=dict)
    docs: str | None = None

    def resolve(self, spec: FileSpec) -> Path:
        return self.root / spec.src

    def expand(self) -> list[tuple[Path, str, bool, bool]]:
        """Flatten every FileSpec into concrete (source_file, dest_relpath, executable, starter).

        Directory sources are walked recursively; the dest keeps the relative
        structure below the source directory.
        """
        out: list[tuple[Path, str, bool, bool]] = []
        for spec in self.files:
            src = self.resolve(spec)
            if not src.exists():
                raise ManifestError(f"{self.name}: '{spec.src}' does not exist at {src}")
            if src.is_dir():
                for child in sorted(p for p in src.rglob("*") if p.is_file()):
                    rel = child.relative_to(src).as_posix()
                    out.append((child, f"{spec.dest}/{rel}", spec.executable, spec.starter))
            else:
                out.append((src, spec.dest, spec.executable, spec.starter))
        return out


def tools_root() -> Path:
    """Where the tool payload lives.

    Inside an installed wheel it is bundled as package data at
    `harness_cli/_tools`; when running from a source checkout it is the
    top-level `harness/` directory.
    """
    bundled = Path(__file__).resolve().parent / "_tools"
    if bundled.is_dir():
        return bundled
    checkout = Path(__file__).resolve().parents[2] / "harness"
    if checkout.is_dir():
        return checkout
    raise ManifestError("cannot locate the harness tool payload")


def load_tool(directory: Path) -> Tool:
    manifest_path = directory / "harness.toml"
    if not manifest_path.is_file():
        raise ManifestError(f"no harness.toml in {directory}")
    try:
        data = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ManifestError(f"{manifest_path}: {exc}") from exc

    for key in ("name", "version", "description"):
        if not data.get(key):
            raise ManifestError(f"{manifest_path}: missing required key '{key}'")

    raw_files = data.get("files") or []
    if not raw_files:
        raise ManifestError(f"{manifest_path}: at least one [[files]] entry is required")

    files = []
    for entry in raw_files:
        if "src" not in entry or "dest" not in entry:
            raise ManifestError(f"{manifest_path}: every [[files]] entry needs 'src' and 'dest'")
        dest = entry["dest"].replace("\\", "/").strip("/")
        if not dest or dest.startswith("../") or "/../" in dest:
            raise ManifestError(f"{manifest_path}: unsafe dest '{entry['dest']}'")
        files.append(FileSpec(
            src=entry["src"],
            dest=dest,
            executable=bool(entry.get("executable")),
            starter=bool(entry.get("starter")),
        ))

    fragment: dict = {}
    fragment_name = data.get("settings", "settings.fragment.json")
    fragment_path = directory / fragment_name
    if fragment_path.is_file():
        try:
            fragment = json.loads(fragment_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ManifestError(f"{fragment_path}: {exc}") from exc
        if not isinstance(fragment, dict):
            raise ManifestError(f"{fragment_path}: settings fragment must be a JSON object")

    # Like `dest`, gitignore entries are relative to the install directory, so
    # one manifest works for both a project and a user install.
    ignores = []
    for entry in data.get("gitignore", []):
        pattern = str(entry).replace("\\", "/").strip()
        if not pattern or pattern.startswith("/") or pattern.startswith("../") or "/../" in pattern:
            raise ManifestError(f"{manifest_path}: unsafe gitignore entry '{entry}'")
        ignores.append(pattern)

    return Tool(
        name=data["name"],
        version=str(data["version"]),
        description=data["description"],
        root=directory,
        files=tuple(files),
        requires=tuple(data.get("requires", [])),
        gitignore=tuple(ignores),
        fragment=fragment,
        docs=data.get("docs"),
    )


def discover(root: Path | None = None) -> dict[str, Tool]:
    """Every installable tool, keyed by name, sorted by name."""
    base = root or tools_root()
    found: dict[str, Tool] = {}
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        if not (directory / "harness.toml").is_file():
            continue
        tool = load_tool(directory)
        found[tool.name] = tool
    return dict(sorted(found.items()))
