"""Discovery and parsing of per-tool ``harness.toml`` manifests."""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from harness_cli.platforms import DESTINATION_ROOTS, Platform


class ManifestError(Exception):
    """A manifest is missing, malformed, or points at files that do not exist."""


class SupportStatus(str, Enum):
    SUPPORTED = "supported"
    REPLACEMENT = "replacement"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class PlatformSupport:
    status: SupportStatus
    reason: str | None = None
    replacement: str | None = None
    fragment_name: str | None = None


@dataclass(frozen=True)
class FileSpec:
    """One source-to-destination copy instruction.

    ``root`` is a logical platform root: ``platform`` (``.claude`` or
    ``.codex``), ``skills`` (``.claude/skills`` or ``.agents/skills``), or
    ``hooks``. Omitting it retains the original ``.claude``-relative syntax.
    ``platforms`` may select payload variants; omitted entries are shared by
    every platform the tool declares supported.
    """

    src: str
    dest: str
    root: str = "platform"
    platforms: tuple[Platform, ...] | None = None
    executable: bool = False
    starter: bool = False

    def applies_to(self, platform: Platform) -> bool:
        return self.platforms is None or platform in self.platforms


@dataclass(frozen=True)
class ExpandedFile:
    source: Path
    dest: str
    root: str
    executable: bool
    starter: bool

    def __iter__(self):
        """Keep legacy four-value unpacking working for downstream callers."""
        yield self.source
        yield self.dest
        yield self.executable
        yield self.starter


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
    platform_support: dict[Platform, PlatformSupport] = field(default_factory=dict)
    platform_fragments: dict[Platform, dict] = field(default_factory=dict)
    docs: str | None = None

    def resolve(self, spec: FileSpec) -> Path:
        return self.root / spec.src

    def support_for(self, platform: Platform | str) -> PlatformSupport:
        selected = Platform.parse(platform)
        return self.platform_support.get(
            selected,
            PlatformSupport(
                SupportStatus.SUPPORTED if selected is Platform.CLAUDE else SupportStatus.UNSUPPORTED,
                reason=(
                    None
                    if selected is Platform.CLAUDE
                    else "No native ChatGPT implementation is available yet."
                ),
            ),
        )

    def fragment_for(self, platform: Platform | str = Platform.CLAUDE) -> dict:
        return self.platform_fragments.get(Platform.parse(platform), {})

    def expand(self, platform: Platform | str = Platform.CLAUDE) -> list[ExpandedFile]:
        """Flatten applicable file specs into concrete payload files."""
        selected = Platform.parse(platform)
        out: list[ExpandedFile] = []
        seen: set[tuple[str, str]] = set()
        for spec in self.files:
            if not spec.applies_to(selected):
                continue
            src = self.resolve(spec)
            if not src.exists():
                raise ManifestError(f"{self.name}: '{spec.src}' does not exist at {src}")
            children = (
                sorted(p for p in src.rglob("*") if p.is_file()) if src.is_dir() else [src]
            )
            for child in children:
                suffix = child.relative_to(src).as_posix() if src.is_dir() else ""
                dest = f"{spec.dest}/{suffix}" if suffix else spec.dest
                key = (spec.root, dest)
                if key in seen:
                    raise ManifestError(
                        f"{self.name}: multiple payloads target {spec.root}:{dest} on {selected.value}"
                    )
                seen.add(key)
                out.append(ExpandedFile(child, dest, spec.root, spec.executable, spec.starter))
        return out


def tools_root() -> Path:
    bundled = Path(__file__).resolve().parent / "_tools"
    if bundled.is_dir():
        return bundled
    checkout = Path(__file__).resolve().parents[2] / "harness"
    if checkout.is_dir():
        return checkout
    raise ManifestError("cannot locate the harness tool payload")


def _safe_relative(value: str, manifest_path: Path, label: str) -> str:
    normalized = str(value).replace("\\", "/").strip("/")
    if not normalized or normalized.startswith("../") or "/../" in normalized:
        raise ManifestError(f"{manifest_path}: unsafe {label} '{value}'")
    return normalized


def _read_fragment(path: Path) -> dict:
    try:
        fragment = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestError(f"{path}: {exc}") from exc
    if not isinstance(fragment, dict):
        raise ManifestError(f"{path}: config fragment must be a JSON object")
    return fragment


def _parse_platforms(data: dict, manifest_path: Path) -> dict[Platform, PlatformSupport]:
    raw = data.get("platforms", {})
    if not isinstance(raw, dict):
        raise ManifestError(f"{manifest_path}: 'platforms' must be a table")
    parsed: dict[Platform, PlatformSupport] = {}
    for name, entry in raw.items():
        try:
            platform = Platform.parse(name)
        except ValueError as exc:
            raise ManifestError(f"{manifest_path}: {exc}") from exc
        if not isinstance(entry, dict):
            raise ManifestError(f"{manifest_path}: platforms.{name} must be a table")
        try:
            status = SupportStatus(entry.get("status", "supported"))
        except ValueError as exc:
            allowed = ", ".join(v.value for v in SupportStatus)
            raise ManifestError(
                f"{manifest_path}: platforms.{name}.status must be one of: {allowed}"
            ) from exc
        replacement = entry.get("replacement")
        if status is SupportStatus.REPLACEMENT and not replacement:
            raise ManifestError(
                f"{manifest_path}: platforms.{name} replacement status needs 'replacement'"
            )
        parsed[platform] = PlatformSupport(
            status=status,
            reason=entry.get("reason"),
            replacement=replacement,
            fragment_name=entry.get("fragment"),
        )
    return parsed


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
        dest = _safe_relative(entry["dest"], manifest_path, "dest")
        root = entry.get("root", "platform")
        if root not in DESTINATION_ROOTS:
            raise ManifestError(
                f"{manifest_path}: files.root must be one of: {', '.join(sorted(DESTINATION_ROOTS))}"
            )
        selected = entry.get("platforms")
        try:
            platforms = tuple(Platform.parse(p) for p in selected) if selected is not None else None
        except (TypeError, ValueError) as exc:
            raise ManifestError(f"{manifest_path}: invalid files.platforms value") from exc
        files.append(
            FileSpec(
                src=entry["src"],
                dest=dest,
                root=root,
                platforms=platforms,
                executable=bool(entry.get("executable")),
                starter=bool(entry.get("starter")),
            )
        )

    support = _parse_platforms(data, manifest_path)
    support.setdefault(Platform.CLAUDE, PlatformSupport(SupportStatus.SUPPORTED))

    fragments: dict[Platform, dict] = {}
    legacy_name = data.get("settings", "settings.fragment.json")
    legacy_path = directory / legacy_name
    if legacy_path.is_file():
        fragments[Platform.CLAUDE] = _read_fragment(legacy_path)
    for platform, declaration in support.items():
        if not declaration.fragment_name:
            continue
        fragment_path = directory / declaration.fragment_name
        if not fragment_path.is_file():
            raise ManifestError(f"{manifest_path}: fragment '{declaration.fragment_name}' does not exist")
        fragments[platform] = _read_fragment(fragment_path)

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
        fragment=fragments.get(Platform.CLAUDE, {}),
        platform_support=support,
        platform_fragments=fragments,
        docs=data.get("docs"),
    )


def discover(root: Path | None = None) -> dict[str, Tool]:
    base = root or tools_root()
    found: dict[str, Tool] = {}
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        if not (directory / "harness.toml").is_file():
            continue
        tool = load_tool(directory)
        found[tool.name] = tool
    return dict(sorted(found.items()))
