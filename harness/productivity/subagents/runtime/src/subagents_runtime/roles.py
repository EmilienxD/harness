"""Provider skill discovery for explicit child skill requests."""
from __future__ import annotations

import os
import json
import re
from collections.abc import Iterator
from pathlib import Path

NAME = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")


def project_directories(cwd: Path) -> Iterator[Path]:
    """Search from the saved directory through its repository root."""
    current = cwd.resolve()
    for parent in (current, *current.parents):
        yield parent
        if (parent / ".git").exists():
            break


def pi_agent_directory() -> Path:
    configured = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".pi" / "agent"


def skill_roots(cwd: Path, provider: str) -> Iterator[Path]:
    """Nearest project skills first, stopping at the repository boundary."""
    if provider == "pi":
        # Pi reads .pi only in the working directory, and Agent Skills locations up to the repository.
        yield cwd.resolve() / ".pi" / "skills"
        for parent in project_directories(cwd):
            yield parent / ".agents" / "skills"
        yield pi_agent_directory() / "skills"
        yield Path.home() / ".agents" / "skills"
        return
    directory = ".claude" if provider == "claude" else ".agents"
    for parent in project_directories(cwd):
        yield parent / directory / "skills"
    home = Path.home()
    global_root = (
        Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))).expanduser()
        if provider == "claude" else home / ".agents"
    )
    yield global_root / "skills"


def pi_package_skill(cwd: Path, name: str, *, require_extensions: bool = False) -> Path | None:
    """Resolve declared native npm resources, respecting disabled resource categories."""
    seen: set[str] = set()
    for root in (cwd.resolve() / ".pi", pi_agent_directory()):
        settings_path = root / "settings.json"
        if not settings_path.is_file():
            continue
        settings = json.loads(settings_path.read_text(encoding="utf-8-sig"))
        for entry in settings.get("packages", []):
            source = entry.get("source", "") if isinstance(entry, dict) else entry
            if not isinstance(source, str) or not source.startswith("npm:"):
                continue
            package_name = source[4:].split("@", 1)[0]
            if package_name in seen:
                continue
            seen.add(package_name)
            package = root / "npm/node_modules" / package_name
            manifest = package / "package.json"
            if not manifest.is_file():
                continue
            resources = json.loads(manifest.read_text(encoding="utf-8-sig")).get("pi", {})
            skill = package / "skills" / name / "SKILL.md"
            declared = resources.get("skills", [])
            if f"skills/{name}" not in declared and "skills" not in declared:
                continue
            # Non-default resource filters require native discovery evidence, not a guess.
            if isinstance(entry, dict) and any(key in entry for key in ("skills", "extensions")):
                continue
            if require_extensions:
                extensions = resources.get("extensions", [])
                if not extensions or not all((package / path).exists() for path in extensions):
                    continue
            if skill.is_file():
                return skill
    return None


def find_skill(cwd: Path, provider: str, name: str) -> Path | None:
    local = next(
        (
            path for root in skill_roots(cwd, provider)
            if (path := root / name / "SKILL.md").is_file()
        ),
        None,
    )
    return local or (pi_package_skill(cwd, name) if provider == "pi" else None)


def builtin_toolkit() -> Path:
    packaged = Path(__file__).parent / "resources" / "subagents-toolkit.md"
    if packaged.is_file():
        return packaged
    return Path(__file__).resolve().parents[3] / "subagents-toolkit" / "SKILL.md"
