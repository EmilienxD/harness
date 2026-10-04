"""Task definitions shared by the toolkit skill and delegation runtime."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import yaml


class RoleError(ValueError):
    """The selected toolkit cannot supply valid task definitions."""


class _RegistryLoader(yaml.SafeLoader):
    """Reject duplicate keys instead of silently replacing a role definition."""


def _mapping(loader, node):
    pairs = loader.construct_pairs(node)
    mapping = {}
    for key, value in pairs:
        if not isinstance(key, str):
            raise RoleError("registry keys must be strings")
        if key in mapping:
            raise RoleError(f"duplicate registry key {key!r}")
        mapping[key] = value
    return mapping


_RegistryLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


@dataclass(frozen=True)
class TaskPolicy:
    task: str
    modes: frozenset[str]
    skill: str | None = None
    default_mode: str = "auto"


NAME = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
REGISTRY = re.compile(r"^```yaml subagent-tasks\r?\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)
LOOP_POLICY = TaskPolicy("loop", frozenset({"loop"}), default_mode="loop")


def skill_roots(cwd: Path, provider: str) -> Iterator[Path]:
    """Nearest project skills first, stopping at the repository boundary."""
    directory = ".claude" if provider == "claude" else ".agents"
    current = cwd.resolve()
    for parent in (current, *current.parents):
        yield parent / directory / "skills"
        if (parent / ".git").exists():
            break
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
    # Editable checkout: the wheel includes this same file as package data.
    return Path(__file__).resolve().parents[3] / "subagents-toolkit" / "SKILL.md"


def read_task_policies(path: Path) -> dict[str, TaskPolicy]:
    try:
        blocks = REGISTRY.findall(path.read_text(encoding="utf-8"))
        if len(blocks) != 1:
            raise RoleError("expected exactly one yaml subagent-tasks block")
        tasks = yaml.load(blocks[0], Loader=_RegistryLoader)
        if not isinstance(tasks, dict) or not tasks:
            raise RoleError("task registry must be a nonempty mapping")
        policies = {}
        for task, definition in tasks.items():
            if not isinstance(task, str) or not NAME.fullmatch(task) or task == "loop":
                raise RoleError(f"invalid or reserved task {task!r}")
            if not isinstance(definition, dict) or set(definition) != {
                "launcher", "skill", "modes", "default-mode"
            }:
                raise RoleError(f"task {task!r} requires launcher, skill, modes and default-mode")
            launcher, skill = definition["launcher"], definition["skill"]
            modes, default = definition["modes"], definition["default-mode"]
            if (
                not isinstance(launcher, str) or not NAME.fullmatch(launcher)
                or not launcher.endswith("-with-agent")
            ):
                raise RoleError(f"invalid launcher for task {task!r}")
            if launcher in policies:
                raise RoleError(f"duplicate launcher {launcher!r}")
            if skill is None:
                if task not in {"general", "explore"}:
                    raise RoleError(f"task {task!r} requires a child skill")
            elif (
                not isinstance(skill, str) or not NAME.fullmatch(skill)
                or skill.endswith("-with-agent")
                or skill in {"subagents-toolkit", "reply-to-agent", "resume-agent", "ship"}
            ):
                raise RoleError(f"invalid child skill for task {task!r}")
            if (
                not isinstance(modes, list) or not modes
                or any(mode not in ("auto", "interactive") for mode in modes)
            ):
                raise RoleError(f"invalid modes for task {task!r}")
            if not isinstance(default, str) or default not in modes:
                raise RoleError(f"invalid default-mode for task {task!r}")
            policies[launcher] = TaskPolicy(task, frozenset(modes), skill, default)
        return policies
    except (OSError, UnicodeError, yaml.YAMLError, RoleError) as exc:
        raise RoleError(f"Invalid subagent task registry in {path}: {exc}") from exc


def load_task_policies(cwd: Path, provider: str) -> dict[str, TaskPolicy]:
    path = find_skill(cwd, provider, "subagents-toolkit") or builtin_toolkit()
    return {**read_task_policies(path), "ship": LOOP_POLICY}


def task_policy(task: str, cwd: Path, provider: str) -> TaskPolicy | None:
    if task == "loop":
        return LOOP_POLICY
    return next(
        (policy for policy in load_task_policies(cwd, provider).values() if policy.task == task),
        None,
    )
