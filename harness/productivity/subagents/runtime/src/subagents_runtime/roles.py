"""Task definitions shared by the toolkit skill and delegation runtime."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import yaml

from subagents_runtime.storage import state_dir


class RoleError(ValueError):
    """The toolkit or custom registries cannot supply valid task definitions."""


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
    # Editable checkout: the wheel includes this same file as package data.
    return Path(__file__).resolve().parents[3] / "subagents-toolkit" / "SKILL.md"


def _parse_task_policies(tasks: dict) -> dict[str, TaskPolicy]:
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
            or skill in {"subagents-toolkit", "reply-to-agent", "reply-to-agent-with-previous-message", "resume-agent", "ship"}
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


def read_task_policies(path: Path, *, custom: bool = False) -> dict[str, TaskPolicy]:
    """Read companion runtime definitions, legacy fenced defaults, or custom YAML."""
    plain_yaml = custom
    if not custom:
        companion = path.with_name("builtin-tasks.yaml")
        if companion.exists():
            path = companion
            plain_yaml = True
    try:
        content = path.read_text(encoding="utf-8")
        if not plain_yaml:
            blocks = REGISTRY.findall(content)
            if len(blocks) != 1:
                raise RoleError("expected exactly one yaml subagent-tasks block")
            content = blocks[0]
        tasks = yaml.load(content, Loader=_RegistryLoader)
        if not isinstance(tasks, dict) or (not custom and not tasks):
            requirement = "a mapping" if custom else "a nonempty mapping"
            raise RoleError(f"task registry must be {requirement}")
        return _parse_task_policies(tasks)
    except (OSError, UnicodeError, yaml.YAMLError, RoleError) as exc:
        raise RoleError(f"Invalid subagent task registry in {path}: {exc}") from exc


def custom_registry_paths(cwd: Path) -> tuple[Path, Path]:
    """Resolve the personal and project files for both runtime and agent context."""
    project_registry = next(
        (path for parent in project_directories(cwd)
         if (path := parent / ".harness" / "subagent-tasks.yaml").exists()),
        cwd.resolve() / ".harness" / "subagent-tasks.yaml",
    )
    return state_dir() / "subagent-tasks.yaml", project_registry


def load_task_policies(cwd: Path, provider: str) -> dict[str, TaskPolicy]:
    """Add personal and nearest-project custom tasks to the selected toolkit."""
    path = find_skill(cwd, provider, "subagents-toolkit") or builtin_toolkit()
    defaults = read_task_policies(path)
    builtin_tasks = {policy.task for policy in defaults.values()} | {"loop", "ship"}
    registries = dict.fromkeys(custom_registry_paths(cwd))
    custom_tasks: dict[str, tuple[str, TaskPolicy, Path]] = {}
    for registry in registries:
        if not registry.exists():
            continue
        for launcher, policy in read_task_policies(registry, custom=True).items():
            if policy.task in builtin_tasks or launcher in defaults:
                raise RoleError(
                    f"Invalid subagent task registry in {registry}: "
                    f"builtin task or launcher cannot be replaced ({policy.task!r}, {launcher!r})"
                )
            custom_tasks[policy.task] = (launcher, policy, registry)
    policies = dict(defaults)
    for launcher, policy, registry in custom_tasks.values():
        if launcher in policies:
            raise RoleError(f"Invalid subagent task registry in {registry}: duplicate launcher {launcher!r}")
        policies[launcher] = policy
    return {**policies, "ship": LOOP_POLICY}


def task_policy(task: str, cwd: Path, provider: str) -> TaskPolicy | None:
    if task == "loop":
        return LOOP_POLICY
    return next(
        (policy for policy in load_task_policies(cwd, provider).values() if policy.task == task),
        None,
    )
