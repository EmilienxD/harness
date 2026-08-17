"""Copying tool files into `.claude/` and merging the settings they need.

Installing leaves nothing behind but the tool's own files: no lock file, no
backups. Everything an uninstall needs to know — which paths belong to a tool,
and what it added to settings.json — is already in the tool's manifest, so
there is no reason to write a second copy of it into the user's repo.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from harness_cli import gitignore, settings_merge
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

    @property
    def gitignore_path(self) -> Path:
        """Where a `.gitignore` covering this install belongs.

        A project install writes the repo's own root `.gitignore`, since the
        secrets being hidden sit under `.claude/` inside that repo. A user
        install has no repo, so it writes inside `~/.claude` — which matters
        for the common case of dotfiles kept in git, and is inert otherwise.
        """
        if self.is_user:
            return self.claude_dir / ".gitignore"
        return self.claude_dir.parent / ".gitignore"

    def gitignore_pattern(self, entry: str) -> str:
        """Manifest entries are install-dir-relative, exactly like `dest`."""
        return entry if self.is_user else f".claude/{entry}"

    def read_gitignore(self) -> str:
        path = self.gitignore_path
        return path.read_text(encoding="utf-8-sig") if path.is_file() else ""

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


# Last resort when no interpreter is found at all: install proceeds (with a
# missing-requirements warning) under the platform's usual name, so a later
# uninstall on the same still-broken machine predicts the same string and
# backs the entry out cleanly.
FALLBACK_PYTHON = "python" if os.name == "nt" else "python3"


def _interpreter_works(path: str) -> bool:
    """A python that exists on PATH is not necessarily a python that runs.

    Windows' Microsoft Store 'app execution alias' ships python.exe and
    python3.exe stubs that pass `shutil.which` but only open the Store when
    launched; a stray Python 2 as `python` is the other classic trap. Running
    a trivial program is the only reliable test, and checks both at once.
    """
    try:
        result = subprocess.run(
            [path, "-c", "import sys; sys.exit(sys.version_info[0] != 3)"],
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def python_command() -> tuple[str, list[str]] | None:
    """Command and args to run Python 3 scripts, or None.

    When `uv` is installed (which it is if the user installed via uvx), prefer
    `uv run --no-project` over an absolute Python path — it's more portable and
    doesn't point into uv's cache directories.

    Returns (command, args_prefix) where args_prefix goes before the script path.
    For `uv run`: ("uv", ["run", "--no-project"]), for direct python: (path, []).
    """
    # Prefer uv run when available (user installed with uvx → uv is present)
    if shutil.which("uv"):
        return ("uv", ["run", "--no-project"])

    # Fallback to direct Python interpreter
    for candidate in ("python3", "python", "py"):
        found = shutil.which(candidate)
        if found and _interpreter_works(found):
            return (found, [])
    return None


def substitute(value, target: "Target | None" = None, python_info=None):
    """Expand manifest placeholders throughout a settings fragment.

    `${PYTHON}` is expanded into command + args for running Python scripts.
    When `uv` is available: `command: "uv", args: ["run", "<script>"]`.
    Otherwise: `command: "<python-path>", args: ["<script>"]`.

    `${CLAUDE_DIR}` becomes the directory the tool was installed into — Claude
    Code's own `${CLAUDE_PROJECT_DIR}/.claude` for a project install, and an
    absolute path for a user-level one (where `${CLAUDE_PROJECT_DIR}` would
    point at whatever project happens to be open, not at the hook).
    """
    if python_info is None and "${PYTHON}" in json.dumps(value):
        result = python_command()
        python_info = result if result else (FALLBACK_PYTHON, [])

    if isinstance(value, str):
        claude_dir = (
            target.claude_dir.as_posix()
            if target and target.is_user
            else "${CLAUDE_PROJECT_DIR}/.claude"
        )
        return value.replace("${CLAUDE_DIR}", claude_dir)

    if isinstance(value, dict):
        # Special handling for hook command/args pattern
        if value.get("type") == "command" and "${PYTHON}" in json.dumps(value):
            command, args_prefix = python_info
            script_args = value.get("args", [])
            # Expand ${CLAUDE_DIR} in script args
            expanded_args = [
                arg.replace(
                    "${CLAUDE_DIR}",
                    target.claude_dir.as_posix()
                    if target and target.is_user
                    else "${CLAUDE_PROJECT_DIR}/.claude",
                )
                for arg in script_args
            ]
            return {
                **{k: v for k, v in value.items() if k not in ("command", "args")},
                "command": command,
                "args": args_prefix + expanded_args,
            }
        return {k: substitute(v, target, python_info) for k, v in value.items()}

    if isinstance(value, list):
        return [substitute(v, target, python_info) for v in value]

    return value


def restore_proxied_hooks(settings: dict) -> None:
    """Undo the retired `stopHook` proxy convention, in place.

    One version of redirect-subagents rewrote every other Stop/SubagentStop
    hook to run through its wait script, recording the argv it replaced under
    a harness-owned `_proxied` key. Nothing writes that shape any more:
    rewriting hooks the user wrote themselves was never ours to do, and
    Claude Code validates project settings strictly enough that inventing
    keys inside a hook entry is a bad bet. Any entry still carrying
    `_proxied` is restored to the argv it records, so a settings file left
    behind by that version heals on the next install or uninstall.
    """
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for groups in hooks.values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                continue
            restored = []
            for entry in group["hooks"]:
                if isinstance(entry, dict) and isinstance(entry.get("_proxied"), list):
                    orig = entry.pop("_proxied")
                    entry = {k: v for k, v in entry.items() if k not in ("command", "args")}
                    if orig:
                        entry["command"], entry["args"] = orig[0], orig[1:]
                restored.append(entry)
            group["hooks"] = restored


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
    gitignore_before: str = ""
    gitignore_after: str = ""
    missing_requirements: list[str] = field(default_factory=list)

    @property
    def settings_changed(self) -> bool:
        return self.settings_before != self.settings_after

    @property
    def gitignore_changed(self) -> bool:
        return self.gitignore_before != self.gitignore_after


def is_installed(tool: Tool, target: Target) -> bool:
    """A tool counts as installed when every file it ships is present.

    Presence of the files is the state — there is no separate record to consult
    and therefore nothing that can disagree with what is actually on disk.
    """
    expanded = tool.expand()
    return bool(expanded) and all((target.claude_dir / dest).is_file() for _, dest, _, _ in expanded)


def plan_install(
    tool: Tool,
    target: Target,
    settings_override: dict | None = None,
    gitignore_override: str | None = None,
) -> Plan:
    """Compute what installing `tool` would change.

    `settings_override` and `gitignore_override` let a caller thread the result
    of a previous plan through, so a batch install of several tools stacks their
    changes instead of each one merging onto the same original file.
    """
    actions: list[FileAction] = []
    for source, dest, executable, starter in tool.expand():
        path = target.claude_dir / dest
        if not path.exists():
            status = "new"
        elif sha256(path) == sha256(source):
            status = "unchanged"
        elif dest.endswith(".rules") or starter:
            # Never overwrite user-edited starter files — they're templates
            # meant to be customized, not versioned config we maintain.
            # (.rules predates the manifest flag and stays accepted.)
            status = "unchanged"
        else:
            status = "overwrite"
        actions.append(FileAction(dest=dest, source=source, executable=executable, status=status))

    needs_python = "${PYTHON}" in json.dumps(tool.fragment)
    python_info = python_command() if needs_python else None
    fallback_info = (FALLBACK_PYTHON, []) if needs_python else None
    fragment = substitute(tool.fragment, target, python_info or fallback_info)
    before = target.read_settings() if settings_override is None else settings_override
    # The heal below rewrites entries, so it works on a copy: `before` stays
    # the file as found, and a plan that only heals still reads as a change.
    base = copy.deepcopy(before)
    restore_proxied_hooks(base)  # settings left behind by the retired stopHook convention
    after = settings_merge.merge(base, fragment) if fragment else base

    ignore_before = (
        target.read_gitignore() if gitignore_override is None else gitignore_override
    )
    patterns = [target.gitignore_pattern(entry) for entry in tool.gitignore]
    ignore_after = (
        gitignore.apply(ignore_before, tool.name, patterns) if patterns else ignore_before
    )

    missing = [c for c in tool.requires if shutil.which(c) is None]
    if needs_python and python_info is None:
        # Settings are still written (with a fallback name) so there is a real
        # entry to fix forward from once Python is installed — but say so.
        missing.append("python")

    return Plan(
        tool=tool,
        target=target,
        fragment=fragment,
        files=actions,
        settings_before=before,
        settings_after=after,
        gitignore_before=ignore_before,
        gitignore_after=ignore_after,
        missing_requirements=missing,
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

    if plan.gitignore_changed:
        path = target.gitignore_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(plan.gitignore_after, encoding="utf-8")

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

    for source, dest, _, _ in tool.expand():
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
        healed = copy.deepcopy(before)
        restore_proxied_hooks(healed)  # settings left by the retired stopHook convention
        after = settings_merge.unmerge(healed, fragment)
        if after != before:
            removed_any = True
            if after:
                target.settings_path.write_text(settings_merge.dumps(after), encoding="utf-8")
            else:
                target.settings_path.unlink(missing_ok=True)
                notes.append(f"removed now-empty {target.settings_name}")

    notes += [f"removed leftover {name}" for name in target.sweep_legacy()]

    # Back out the .gitignore block. Patterns the user had written themselves
    # were never inside our fence, so they survive untouched.
    if tool.gitignore:
        before = target.read_gitignore()
        after = gitignore.remove(before, tool.name)
        if after != before:
            removed_any = True
            if after.strip():
                target.gitignore_path.write_text(after, encoding="utf-8")
            else:
                target.gitignore_path.unlink(missing_ok=True)
                notes.append(f"removed now-empty {target.gitignore_path.name}")

    # If nothing is left in .claude/, we created it and should take it with us.
    if target.claude_dir.is_dir():
        try:
            target.claude_dir.rmdir()
        except OSError:
            pass

    if not removed_any and not notes:
        notes.append("nothing to remove")
    return notes
