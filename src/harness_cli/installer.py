"""Copying tool files into `.claude/` and merging the settings they need.

Installing leaves nothing behind but the tool's own files: no lock file, no
backups. Everything an uninstall needs to know — which paths belong to a tool,
and what it added to settings.json — is already in the tool's manifest, so
there is no reason to write a second copy of it into the user's repo.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass, field
from pathlib import Path

from harness_cli import settings_merge
from harness_cli.manifest import Tool

# Written by earlier versions of this installer; removed on sight.
LEGACY_ARTIFACTS = (".harness.lock.json", "settings.json.bak", "settings.local.json.bak")


class InstallError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    """Where an install lands: a `.claude/` directory and one settings file."""

    claude_dir: Path
    settings_name: str = "settings.json"
    is_user: bool = False

    @classmethod
    def for_project(cls, root: Path, settings_name: str = "settings.json") -> "Target":
        return cls(claude_dir=root / ".claude", settings_name=settings_name)

    @classmethod
    def for_user(cls, settings_name: str = "settings.json") -> "Target":
        return cls(claude_dir=Path.home() / ".claude", settings_name=settings_name, is_user=True)

    @property
    def settings_path(self) -> Path:
        return self.claude_dir / self.settings_name

    def read_settings(self) -> dict:
        if not self.settings_path.is_file():
            return {}
        text = self.settings_path.read_text(encoding="utf-8-sig")
        if not text.strip():
            return {}
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InstallError(f"{self.settings_path} is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise InstallError(f"{self.settings_path} must contain a JSON object")
        return data

    def sweep_legacy(self) -> list[str]:
        """Delete artifacts older versions of this installer used to leave behind."""
        removed = []
        for name in LEGACY_ARTIFACTS:
            path = self.claude_dir / name
            if path.is_file():
                path.unlink()
                removed.append(name)
        return removed


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def python_command() -> str:
    """The interpreter name hooks should invoke on this machine.

    `python3` does not exist on a stock Windows install and `python` is often
    absent on Linux, so the manifest writes `${PYTHON}` and we resolve it here
    rather than making every user edit their settings.json by hand.
    """
    for candidate in ("python3", "python"):
        if shutil.which(candidate):
            return candidate
    return "python3"


def substitute(value, target: "Target | None" = None):
    """Expand manifest placeholders throughout a settings fragment.

    `${PYTHON}` becomes the interpreter that exists on this machine.
    `${CLAUDE_DIR}` becomes the directory the tool was installed into — Claude
    Code's own `${CLAUDE_PROJECT_DIR}/.claude` for a project install, and an
    absolute path for a user-level one (where `${CLAUDE_PROJECT_DIR}` would
    point at whatever project happens to be open, not at the hook).
    """
    if isinstance(value, str):
        claude_dir = (
            target.claude_dir.as_posix()
            if target and target.is_user
            else "${CLAUDE_PROJECT_DIR}/.claude"
        )
        return value.replace("${PYTHON}", python_command()).replace("${CLAUDE_DIR}", claude_dir)
    if isinstance(value, dict):
        return {k: substitute(v, target) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, target) for v in value]
    return value


@dataclass
class FileAction:
    dest: str
    source: Path
    executable: bool
    status: str  # new | overwrite | unchanged


@dataclass
class Plan:
    tool: Tool
    target: Target
    fragment: dict = field(default_factory=dict)
    files: list[FileAction] = field(default_factory=list)
    settings_before: dict = field(default_factory=dict)
    settings_after: dict = field(default_factory=dict)
    missing_requirements: list[str] = field(default_factory=list)

    @property
    def settings_changed(self) -> bool:
        return self.settings_before != self.settings_after


def is_installed(tool: Tool, target: Target) -> bool:
    """A tool counts as installed when every file it ships is present.

    Presence of the files is the state — there is no separate record to consult
    and therefore nothing that can disagree with what is actually on disk.
    """
    expanded = tool.expand()
    return bool(expanded) and all((target.claude_dir / dest).is_file() for _, dest, _ in expanded)


def plan_install(tool: Tool, target: Target, settings_override: dict | None = None) -> Plan:
    """Compute what installing `tool` would change.

    `settings_override` lets a caller thread the result of a previous plan
    through, so a batch install of several tools stacks their fragments instead
    of each one merging onto the same original file.
    """
    actions: list[FileAction] = []
    for source, dest, executable in tool.expand():
        path = target.claude_dir / dest
        if not path.exists():
            status = "new"
        elif sha256(path) == sha256(source):
            status = "unchanged"
        else:
            status = "overwrite"
        actions.append(FileAction(dest=dest, source=source, executable=executable, status=status))

    fragment = substitute(tool.fragment, target)
    before = target.read_settings() if settings_override is None else settings_override
    after = settings_merge.merge(before, fragment) if fragment else before

    return Plan(
        tool=tool,
        target=target,
        fragment=fragment,
        files=actions,
        settings_before=before,
        settings_after=after,
        missing_requirements=[c for c in tool.requires if shutil.which(c) is None],
    )


def _make_executable(path: Path) -> None:
    if os.name == "nt":
        return
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def apply_install(plan: Plan) -> list[str]:
    """Execute a plan. Returns human-readable notes about what happened."""
    target = plan.target
    target.claude_dir.mkdir(parents=True, exist_ok=True)

    for action in plan.files:
        if action.status == "unchanged":
            continue
        path = target.claude_dir / action.dest
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(action.source, path)
        if action.executable:
            _make_executable(path)

    if plan.settings_changed:
        target.settings_path.write_text(settings_merge.dumps(plan.settings_after), encoding="utf-8")

    return [f"removed leftover {name}" for name in target.sweep_legacy()]


def _prune_empty_parents(path: Path, stop: Path) -> None:
    """Remove now-empty directories left by a deleted file, up to but not including `stop`."""
    current = path.parent
    while stop in current.parents:
        try:
            next(current.iterdir())
            return
        except StopIteration:
            current.rmdir()
        except OSError:
            return
        current = current.parent


def uninstall(tool: Tool, target: Target, force: bool = False) -> list[str]:
    """Remove a tool's files and back its settings fragment out again.

    A file whose contents no longer match what we shipped is assumed to be the
    user's and is left in place unless `force` is set — the same conservatism
    the lock file used to provide, without needing to store anything.
    """
    notes: list[str] = []
    removed_any = False

    for source, dest, _ in tool.expand():
        path = target.claude_dir / dest
        if not path.is_file():
            continue
        if sha256(path) != sha256(source) and not force:
            notes.append(f"kept {dest} (modified since install)")
            continue
        path.unlink()
        _prune_empty_parents(path, target.claude_dir)
        removed_any = True

    fragment = substitute(tool.fragment, target)
    if fragment:
        before = target.read_settings()
        after = settings_merge.unmerge(before, fragment)
        if after != before:
            removed_any = True
            if after:
                target.settings_path.write_text(settings_merge.dumps(after), encoding="utf-8")
            else:
                target.settings_path.unlink(missing_ok=True)
                notes.append(f"removed now-empty {target.settings_name}")

    notes += [f"removed leftover {name}" for name in target.sweep_legacy()]

    # If nothing is left in .claude/, we created it and should take it with us.
    if target.claude_dir.is_dir():
        try:
            target.claude_dir.rmdir()
        except OSError:
            pass

    if not removed_any and not notes:
        notes.append("nothing to remove")
    return notes
