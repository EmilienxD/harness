"""Discovery and parsing of per-tool ``harness.toml`` manifests."""

from __future__ import annotations

import json
import re
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

    ``root`` is a logical destination root: ``workspace``, ``platform``
    (``.claude`` or ``.codex``), ``skills`` (``.claude/skills`` or
    ``.agents/skills``), or ``hooks``.
    ``platforms`` may select payload variants; omitted entries are shared by
    every platform the tool declares supported.
    """

    src: str
    dest: str
    root: str = "platform"
    platforms: tuple[Platform, ...] | None = None
    executable: bool = False
    starter: bool = False
    scopes: tuple[str, ...] | None = None

    def applies_to(self, platform: Platform, scope: str) -> bool:
        return (self.platforms is None or platform in self.platforms) and (
            self.scopes is None or scope in self.scopes
        )


@dataclass(frozen=True)
class ExpandedFile:
    source: Path
    dest: str
    root: str
    executable: bool
    starter: bool


@dataclass(frozen=True)
class PackageDependency:
    """A catalogue package dependency with an optional version constraint."""

    name: str
    constraint: str = ""


@dataclass(frozen=True)
class HostAction:
    """A machine-level action performed by the catalogue installer."""

    type: str
    data: dict[str, object]


@dataclass(frozen=True)
class Tool:
    name: str
    version: str
    description: str
    root: Path
    files: tuple[FileSpec, ...]
    selectable: bool = True
    requires: tuple[str, ...] = ()
    gitignore: tuple[str, ...] = ()
    workspace_gitignore: tuple[str, ...] = ()
    platform_support: dict[Platform, PlatformSupport] = field(default_factory=dict)
    platform_fragments: dict[Platform, dict] = field(default_factory=dict)
    docs: str | None = None
    dependencies: tuple[PackageDependency, ...] = ()
    actions: tuple[HostAction, ...] = ()

    def resolve(self, spec: FileSpec) -> Path:
        return self.root / spec.src

    def support_for(self, platform: Platform | str) -> PlatformSupport:
        selected = Platform.parse(platform)
        return self.platform_support.get(
            selected, PlatformSupport(SupportStatus.UNSUPPORTED, reason="No support is declared.")
        )

    def fragment_for(self, platform: Platform | str = Platform.CLAUDE) -> dict:
        return self.platform_fragments.get(Platform.parse(platform), {})

    def expand(
        self, platform: Platform | str = Platform.CLAUDE, scope: str = "project"
    ) -> list[ExpandedFile]:
        """Flatten applicable file specs into concrete payload files."""
        selected = Platform.parse(platform)
        out: list[ExpandedFile] = []
        seen: set[tuple[str, str]] = set()
        for spec in self.files:
            if not spec.applies_to(selected, scope):
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


_DEPENDENCY_RE = re.compile(r"^([a-z0-9][a-z0-9-]*)(.*)$")


def _parse_dependencies(data: dict, manifest_path: Path) -> tuple[PackageDependency, ...]:
    raw = data.get("dependencies", [])
    if not isinstance(raw, list):
        raise ManifestError(f"{manifest_path}: 'dependencies' must be an array")
    result: list[PackageDependency] = []
    for entry in raw:
        if isinstance(entry, str):
            match = _DEPENDENCY_RE.fullmatch(entry.strip())
            if not match:
                raise ManifestError(f"{manifest_path}: invalid dependency '{entry}'")
            result.append(PackageDependency(match.group(1), match.group(2).strip()))
        elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
            result.append(
                PackageDependency(entry["name"].strip(), str(entry.get("version", "")).strip())
            )
        else:
            raise ManifestError(f"{manifest_path}: invalid dependency entry {entry!r}")
    return tuple(result)


def _parse_actions(data: dict, manifest_path: Path) -> tuple[HostAction, ...]:
    raw = data.get("actions", [])
    if not isinstance(raw, list):
        raise ManifestError(f"{manifest_path}: 'actions' must be an array of tables")
    actions: list[HostAction] = []
    for entry in raw:
        if not isinstance(entry, dict) or not isinstance(entry.get("type"), str):
            raise ManifestError(f"{manifest_path}: every [[actions]] entry needs a string 'type'")
        kind = entry["type"]
        if kind not in {"uv-tool", "vscode-extension"}:
            raise ManifestError(f"{manifest_path}: unsupported host action type '{kind}'")
        if kind == "uv-tool":
            if not all(isinstance(entry.get(key), str) and entry[key] for key in ("source", "package")):
                raise ManifestError(f"{manifest_path}: uv-tool action requires source and package")
            source = entry["source"]
            revision = source.rsplit("@", 1)[-1].split("#", 1)[0] if "@" in source else ""
            if not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
                raise ManifestError(f"{manifest_path}: uv-tool source must pin a full commit SHA")
        else:
            required_strings = ("url", "sha256", "extension_id")
            if not all(isinstance(entry.get(key), str) and entry[key] for key in required_strings):
                raise ManifestError(
                    f"{manifest_path}: vscode-extension action requires url, sha256, and extension_id"
                )
            if not entry["url"].startswith("https://") or "/download/" not in entry["url"]:
                raise ManifestError(f"{manifest_path}: VSIX URL must be an immutable HTTPS download")
            if not isinstance(entry.get("size"), int) or entry["size"] <= 0:
                raise ManifestError(f"{manifest_path}: VSIX size must be a positive integer")
            if not re.fullmatch(r"[0-9a-fA-F]{64}", entry["sha256"]):
                raise ManifestError(f"{manifest_path}: VSIX sha256 must contain 64 hexadecimal digits")
        actions.append(HostAction(kind, {key: value for key, value in entry.items() if key != "type"}))
    return tuple(actions)


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
    raw_actions = data.get("actions") or []
    if not raw_files and not raw_actions:
        raise ManifestError(f"{manifest_path}: at least one [[files]] or [[actions]] entry is required")

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
        raw_scopes = entry.get("scopes")
        if raw_scopes is not None and (
            not isinstance(raw_scopes, list)
            or not raw_scopes
            or any(scope not in {"project", "user"} for scope in raw_scopes)
        ):
            raise ManifestError(
                f"{manifest_path}: files.scopes must contain only 'project' and/or 'user'"
            )
        files.append(
            FileSpec(
                src=entry["src"],
                dest=dest,
                root=root,
                platforms=platforms,
                executable=bool(entry.get("executable")),
                starter=bool(entry.get("starter")),
                scopes=tuple(raw_scopes) if raw_scopes is not None else None,
            )
        )

    support = _parse_platforms(data, manifest_path)
    if not support:
        raise ManifestError(f"{manifest_path}: at least one [platforms.<name>] table is required")

    fragments: dict[Platform, dict] = {}
    for platform, declaration in support.items():
        if not declaration.fragment_name:
            continue
        fragment_path = directory / declaration.fragment_name
        if not fragment_path.is_file():
            raise ManifestError(f"{manifest_path}: fragment '{declaration.fragment_name}' does not exist")
        fragments[platform] = _read_fragment(fragment_path)

    def ignore_entries(field: str) -> tuple[str, ...]:
        ignores = []
        for entry in data.get(field, []):
            pattern = str(entry).replace("\\", "/").strip()
            if not pattern or pattern.startswith("/") or pattern.startswith("../") or "/../" in pattern:
                raise ManifestError(f"{manifest_path}: unsafe {field} entry '{entry}'")
            ignores.append(pattern)
        return tuple(ignores)

    ignores = ignore_entries("gitignore")
    workspace_ignores = ignore_entries("workspace_gitignore")
    selectable = data.get("selectable", True)
    if not isinstance(selectable, bool):
        raise ManifestError(f"{manifest_path}: 'selectable' must be a boolean")

    return Tool(
        name=data["name"],
        version=str(data["version"]),
        description=data["description"],
        root=directory,
        files=tuple(files),
        selectable=selectable,
        requires=tuple(data.get("requires", [])),
        gitignore=ignores,
        workspace_gitignore=workspace_ignores,
        platform_support=support,
        platform_fragments=fragments,
        docs=data.get("docs"),
        dependencies=_parse_dependencies(data, manifest_path),
        actions=_parse_actions(data, manifest_path),
    )


def discover(root: Path | None = None) -> dict[str, Tool]:
    base = root or tools_root()
    found: dict[str, Tool] = {}
    for manifest_path in sorted(base.rglob("harness.toml")):
        if manifest_path.relative_to(base).parts[0] in {"archive", "deprecated"}:
            continue
        directory = manifest_path.parent
        tool = load_tool(directory)
        if tool.name in found:
            first = found[tool.name].root
            raise ManifestError(
                f"duplicate catalogue package '{tool.name}' in {first} and {directory}"
            )
        found[tool.name] = tool
    return dict(sorted(found.items()))
