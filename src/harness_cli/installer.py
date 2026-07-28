"""Copying tool files into `.claude/` and keeping a record of what was written."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from harness_cli import settings_merge
from harness_cli.manifest import Tool

LOCK_NAME = ".harness.lock.json"
LOCK_VERSION = 1


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

    @property
    def lock_path(self) -> Path:
        return self.claude_dir / LOCK_NAME

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

    def read_lock(self) -> dict:
        if not self.lock_path.is_file():
            return {"version": LOCK_VERSION, "tools": {}}
        try:
            data = json.loads(self.lock_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise InstallError(f"{self.lock_path} is corrupt: {exc}") from exc
        data.setdefault("tools", {})
        return data

    def write_lock(self, lock: dict) -> None:
        lock["version"] = LOCK_VERSION
        if not lock["tools"]:
            self.lock_path.unlink(missing_ok=True)
            return
        self.claude_dir.mkdir(parents=True, exist_ok=True)
        self.lock_path.write_text(
            json.dumps(lock, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@dataclass
class FileAction:
    dest: str
    source: Path
    executable: bool
    status: str  # new | overwrite | unchanged | conflict

    @property
    def writes(self) -> bool:
        return self.status != "unchanged"


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
            target.claude_dir.as_posix() if target and target.is_user else "${CLAUDE_PROJECT_DIR}/.claude"
        )
        return value.replace("${PYTHON}", python_command()).replace("${CLAUDE_DIR}", claude_dir)
    if isinstance(value, dict):
        return {k: substitute(v, target) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, target) for v in value]
    return value


@dataclass
class Plan:
    tool: Tool
    target: Target
    fragment: dict = field(default_factory=dict)
    files: list[FileAction] = field(default_factory=list)
    settings_before: dict = field(default_factory=dict)
    settings_after: dict = field(default_factory=dict)
    missing_requirements: list[str] = field(default_factory=list)
    previously_installed: str | None = None
    orphans: list[str] = field(default_factory=list)

    @property
    def conflicts(self) -> list[FileAction]:
        return [f for f in self.files if f.status == "conflict"]

    @property
    def settings_changed(self) -> bool:
        return self.settings_before != self.settings_after


def _owned_hashes(lock: dict, tool_name: str) -> dict[str, str]:
    entry = lock["tools"].get(tool_name) or {}
    return {f["path"]: f["sha256"] for f in entry.get("files", [])}


def plan_install(tool: Tool, target: Target, settings_override: dict | None = None) -> Plan:
    """Compute what installing `tool` would change.

    `settings_override` lets a caller thread the result of a previous plan
    through, so a batch install of several tools stacks their fragments instead
    of each one merging onto the same original file.
    """
    lock = target.read_lock()
    owned = _owned_hashes(lock, tool.name)
    previous = (lock["tools"].get(tool.name) or {}).get("version")

    actions: list[FileAction] = []
    for source, dest, executable in tool.expand():
        path = target.claude_dir / dest
        if not path.exists():
            status = "new"
        else:
            current = sha256(path)
            if current == sha256(source):
                status = "unchanged"
            elif dest in owned and owned[dest] == current:
                status = "overwrite"  # ours, untouched since install -> safe to update
            else:
                status = "conflict"  # pre-existing or locally edited
        actions.append(FileAction(dest=dest, source=source, executable=executable, status=status))

    fragment = substitute(tool.fragment, target)
    before = target.read_settings() if settings_override is None else settings_override
    after = settings_merge.merge(before, fragment) if fragment else before

    new_dests = {a.dest for a in actions}
    orphans = [d for d in owned if d not in new_dests]

    missing = [cmd for cmd in tool.requires if shutil.which(cmd) is None]

    return Plan(
        tool=tool,
        target=target,
        fragment=fragment,
        files=actions,
        settings_before=before,
        settings_after=after,
        missing_requirements=missing,
        previously_installed=previous,
        orphans=sorted(orphans),
    )


def _make_executable(path: Path) -> None:
    if os.name == "nt":
        return
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _backup_settings(target: Target) -> Path | None:
    if not target.settings_path.is_file():
        return None
    backup = target.settings_path.with_suffix(target.settings_path.suffix + ".bak")
    shutil.copy2(target.settings_path, backup)
    return backup


def apply_install(plan: Plan, force: bool = False) -> list[str]:
    """Execute a plan. Returns human-readable notes about what happened."""
    if plan.conflicts and not force:
        names = ", ".join(f.dest for f in plan.conflicts)
        raise InstallError(
            f"{plan.tool.name}: refusing to overwrite locally modified files: {names}\n"
            "Re-run with --force to overwrite them."
        )

    notes: list[str] = []
    target = plan.target
    target.claude_dir.mkdir(parents=True, exist_ok=True)

    for action in plan.files:
        path = target.claude_dir / action.dest
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(action.source, path)
        if action.executable:
            _make_executable(path)

    for orphan in plan.orphans:
        path = target.claude_dir / orphan
        if path.is_file():
            path.unlink()
            notes.append(f"removed stale file {orphan}")
    _prune_empty_dirs(target.claude_dir)

    if plan.settings_changed:
        backup = _backup_settings(target)
        if backup is not None:
            notes.append(f"backed up settings to {backup.name}")
        target.settings_path.write_text(settings_merge.dumps(plan.settings_after), encoding="utf-8")

    lock = target.read_lock()
    lock["tools"][plan.tool.name] = {
        "version": plan.tool.version,
        "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "settings_file": target.settings_name,
        "files": [
            {"path": a.dest, "sha256": sha256(target.claude_dir / a.dest)}
            for a in sorted(plan.files, key=lambda a: a.dest)
        ],
        "fragment": plan.fragment,
    }
    target.write_lock(lock)
    return notes


def _prune_empty_dirs(root: Path) -> None:
    if not root.is_dir():
        return
    for path in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        try:
            next(path.iterdir())
        except StopIteration:
            path.rmdir()
        except OSError:
            pass


def uninstall(name: str, target: Target, force: bool = False) -> list[str]:
    lock = target.read_lock()
    entry = lock["tools"].get(name)
    if entry is None:
        raise InstallError(f"{name} is not installed in {target.claude_dir}")

    notes: list[str] = []
    for record in entry.get("files", []):
        path = target.claude_dir / record["path"]
        if not path.is_file():
            continue
        if sha256(path) != record["sha256"] and not force:
            notes.append(f"kept {record['path']} (modified since install)")
            continue
        path.unlink()

    fragment = entry.get("fragment") or {}
    if fragment:
        settings_target = Target(target.claude_dir, entry.get("settings_file", "settings.json"))
        before = settings_target.read_settings()
        after = settings_merge.unmerge(before, fragment)
        if after != before:
            _backup_settings(settings_target)
            if after:
                settings_target.settings_path.write_text(
                    settings_merge.dumps(after), encoding="utf-8"
                )
            else:
                settings_target.settings_path.unlink(missing_ok=True)
                notes.append(f"removed now-empty {settings_target.settings_name}")

    del lock["tools"][name]
    target.write_lock(lock)
    _prune_empty_dirs(target.claude_dir)
    return notes
