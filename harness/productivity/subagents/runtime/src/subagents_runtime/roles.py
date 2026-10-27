"""Provider skill discovery for explicit child skill requests."""
from __future__ import annotations

import os
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


def find_skill(cwd: Path, provider: str, name: str) -> Path | None:
    return next(
        (
            path for root in skill_roots(cwd, provider)
            if (path := root / name / "SKILL.md").is_file()
        ),
        None,
    )


def builtin_toolkit() -> Path:
    packaged = Path(__file__).parent / "resources" / "subagents-toolkit.md"
    if packaged.is_file():
        return packaged
    return Path(__file__).resolve().parents[3] / "subagents-toolkit" / "SKILL.md"
