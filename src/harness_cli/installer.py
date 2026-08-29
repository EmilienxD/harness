"""Platform-neutral planning and installation of harness tools.

Installing leaves nothing behind but the tool's own files: no lock file, no
backups. Everything an uninstall needs to know — which paths belong to a tool,
and what it added to settings.json — is already in the tool's manifest, so
there is no reason to write a second copy of it into the user's repo.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from harness_cli import gitignore, settings_merge
from harness_cli.manifest import SupportStatus, Tool
from harness_cli.platforms import Platform, PlatformAdapter, get_adapter

# Public compatibility alias for callers that inspected the old installer.
LEGACY_ARTIFACTS = get_adapter().legacy_artifacts


class InstallError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    """One platform and scope selected for an install."""

    scope_root: Path
    adapter: PlatformAdapter
    is_user: bool = False
    local: bool = False

    @classmethod
    def for_project(
        cls,
        root: Path,
        settings_name: str | None = None,
        platform: Platform | str = Platform.CLAUDE,
    ) -> "Target":
        adapter = get_adapter(platform)
        local = settings_name == "settings.local.json"
        if settings_name not in (None, adapter.config_name, "settings.json", "settings.local.json"):
            raise InstallError(f"custom config filename '{settings_name}' is not supported")
        if adapter.platform is Platform.CHATGPT and settings_name == "settings.json":
            # The old default was settings.json; a caller selecting ChatGPT
            # gets the adapter's native default rather than a Claude filename.
            local = False
        if local and not adapter.supports_local_config:
            raise InstallError(f"--local is not supported for the {adapter.product_name} target")
        return cls(scope_root=root.resolve(), adapter=adapter, local=local)

    @classmethod
    def for_user(
        cls,
        settings_name: str | None = None,
        platform: Platform | str = Platform.CLAUDE,
    ) -> "Target":
        adapter = get_adapter(platform)
        if settings_name not in (None, adapter.config_name, "settings.json"):
            raise InstallError(f"custom user config filename '{settings_name}' is not supported")
        return cls(scope_root=Path.home(), adapter=adapter, is_user=True)

    @property
    def platform(self) -> Platform:
        return self.adapter.platform

    @property
    def install_root(self) -> Path:
        return self.adapter.platform_root(self.scope_root, self.is_user)

    @property
    def claude_dir(self) -> Path:
        """Legacy alias for the primary platform root."""
        return self.install_root

    def destination_root(self, root: str) -> Path:
        return self.adapter.destination_root(self.scope_root, self.is_user, root)

    def destination_path(self, root: str, dest: str) -> Path:
        return self.destination_root(root) / dest

    @property
    def settings_name(self) -> str:
        return self.settings_path.name

    @property
    def settings_path(self) -> Path:
        try:
            return self.adapter.config_path(self.scope_root, self.is_user, self.local)
        except ValueError as exc:
            raise InstallError(str(exc)) from exc

    @property
    def gitignore_path(self) -> Path:
        """Where a `.gitignore` covering this install belongs.

        A project install writes the repo's own root `.gitignore`, since the
        secrets being hidden sit under `.claude/` inside that repo. A user
        install has no repo, so it writes inside `~/.claude` — which matters
        for the common case of dotfiles kept in git, and is inert otherwise.
        """
        if self.is_user:
            return self.install_root / ".gitignore"
        return self.scope_root / ".gitignore"

    def gitignore_pattern(self, entry: str) -> str:
        """Manifest entries are install-dir-relative, exactly like `dest`."""
        return self.adapter.gitignore_pattern(entry, self.is_user)

    def gitignore_block_name(self, tool_name: str) -> str:
        """Identify one platform's entries in a potentially shared file."""
        return tool_name if self.is_user else f"{tool_name}:{self.platform.value}"

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
        for name in self.adapter.legacy_artifacts:
            path = self.install_root / name
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
    `uv run --no-project --no-managed-python` over an absolute Python path; it's
    more portable and doesn't point into uv's cache directories.

    Returns (command, args_prefix) where args_prefix goes before the script path.
    For `uv run`: ("uv", ["run", "--no-project", "--no-managed-python"]), for
    direct python: (path, []).
    """
    # Prefer uv run when available (user installed with uvx → uv is present)
    uv_path = shutil.which("uv")
    if uv_path:
        return ("uv", ["run", "--no-project", "--no-managed-python"])

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
        adapter = target.adapter if target else get_adapter()
        scope_root = target.scope_root if target else Path(".").resolve()
        is_user = target.is_user if target else False
        expanded = value
        for placeholder, replacement in adapter.placeholders(scope_root, is_user).items():
            expanded = expanded.replace(placeholder, replacement)
        if "${PYTHON}" in expanded and python_info:
            command, args_prefix = python_info
            argv = (command, *args_prefix)
            launcher = subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)
            expanded = expanded.replace("${PYTHON}", launcher)
        return expanded

    if isinstance(value, dict):
        # Claude hook commands keep the executable and argv separate. ChatGPT
        # deliberately falls through to ordinary recursive substitution because
        # its native hooks.json schema stores the complete command as one string.
        if (
            (target is None or target.platform is Platform.CLAUDE)
            and value.get("type") == "command"
            and "${PYTHON}" in json.dumps(value)
        ):
            command, args_prefix = python_info
            script_args = value.get("args", [])
            expanded_args = [substitute(arg, target, python_info) for arg in script_args]
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


def rehome_moved_hooks(settings: dict, fragment: dict) -> None:
    """Drop a fragment's own hooks from groups it no longer claims, in place.

    Hook groups merge by matcher scope, so a tool that changes its matcher --
    `Bash` widening to `Bash|PowerShell` when a hook learns about the PowerShell
    tool -- would otherwise leave an old install's group sitting next to the new
    one, running the same script twice on every matching call. Uninstall has the
    mirror problem: it backs out the scope the fragment names now and leaves the
    one it named before.

    Only entries the fragment itself declares are touched, identified the same
    way merge identifies them (by script and arguments, not by interpreter), and
    only where they sit under a scope the fragment doesn't declare for them. A
    hook the user registered themselves runs a different script, so it keys
    differently and stays put — including when it shares a group with ours. A
    second copy of *our* script the user parked under another matcher does key
    the same and is treated as the stale registration.
    """
    hooks = settings.get("hooks")
    fragment_hooks = fragment.get("hooks")
    if not isinstance(hooks, dict) or not isinstance(fragment_hooks, dict):
        return

    for event, fragment_groups in fragment_hooks.items():
        groups = hooks.get(event)
        if not isinstance(groups, list) or not isinstance(fragment_groups, list):
            continue

        # identity -> the scopes this fragment wants that hook to live under
        wanted: dict[tuple, set] = {}
        for group in fragment_groups:
            if not isinstance(group, dict):
                continue
            scope = settings_merge.normalize_scope(group)
            for entry in group.get("hooks", []):
                wanted.setdefault(settings_merge.identity(entry), set()).add(scope)
        if not wanted:
            continue

        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                kept.append(group)
                continue
            scope = settings_merge.normalize_scope(group)
            # `{scope}` as the default keeps anything the fragment never
            # mentioned exactly where it is.
            remaining = [
                entry for entry in group["hooks"]
                if scope in wanted.get(settings_merge.identity(entry), {scope})
            ]
            if remaining == group["hooks"]:
                kept.append(group)
            elif remaining:
                kept.append({**group, "hooks": remaining})
            # A group emptied of hooks fires nothing; drop it.
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]

    if not hooks:
        del settings["hooks"]


@dataclass
class FileAction:
    dest: str
    root: str
    path: Path
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
    if tool.support_for(target.platform).status is not SupportStatus.SUPPORTED:
        return False
    expanded = tool.expand(target.platform)
    return bool(expanded) and all(
        target.destination_path(item.root, item.dest).is_file() for item in expanded
    )


def require_supported(tool: Tool, target: Target) -> None:
    support = tool.support_for(target.platform)
    if support.status is SupportStatus.SUPPORTED:
        return
    if support.status is SupportStatus.REPLACEMENT:
        detail = f" Use {support.replacement} instead."
    else:
        detail = f" {support.reason}" if support.reason else ""
    raise InstallError(
        f"{tool.name} is {support.status.value} for the {target.adapter.product_name} target.{detail}"
    )


def plan_install(
    tool: Tool,
    target: Target,
    settings_override: dict | None = None,
    gitignore_override: str | None = None,
    force: bool = False,
) -> Plan:
    """Compute what installing `tool` would change.

    `settings_override` and `gitignore_override` let a caller thread the result
    of a previous plan through, so a batch install of several tools stacks their
    changes instead of each one merging onto the same original file.

    `force` overwrites user-edited starter files instead of keeping them —
    mirroring `uninstall --force` for files modified since install.
    """
    require_supported(tool, target)
    actions: list[FileAction] = []
    for payload in tool.expand(target.platform):
        source, dest, executable, starter = payload
        path = target.destination_path(payload.root, dest)
        if not path.exists():
            status = "new"
        elif sha256(path) == sha256(source):
            status = "unchanged"
        elif (dest.endswith(".rules") or starter) and not force:
            # Never overwrite user-edited starter files — they're templates
            # meant to be customized, not versioned config we maintain.
            # (.rules predates the manifest flag and stays accepted.)
            status = "unchanged"
        else:
            status = "overwrite"
        actions.append(
            FileAction(
                dest=dest,
                root=payload.root,
                path=path,
                source=source,
                executable=executable,
                status=status,
            )
        )

    native_fragment = tool.fragment_for(target.platform)
    needs_python = "${PYTHON}" in json.dumps(native_fragment)
    python_info = python_command() if needs_python else None
    fallback_info = (FALLBACK_PYTHON, []) if needs_python else None
    fragment = substitute(native_fragment, target, python_info or fallback_info)
    before = target.read_settings() if settings_override is None else settings_override
    # The heal below rewrites entries, so it works on a copy: `before` stays
    # the file as found, and a plan that only heals still reads as a change.
    base = target.adapter.prepare_config(before, fragment)
    after = target.adapter.merge_config(base, fragment) if fragment else base

    ignore_before = (
        target.read_gitignore() if gitignore_override is None else gitignore_override
    )
    ignore_base = ignore_before
    patterns = [target.gitignore_pattern(entry) for entry in tool.gitignore]
    block_name = target.gitignore_block_name(tool.name)
    # Early installs used an unqualified block name. Migrate it only when its
    # contents clearly belong to this target; another platform's legacy block
    # in the same shared .gitignore must remain.
    if not target.is_user:
        legacy = gitignore.block_patterns(ignore_base, tool.name)
        prefix = f"{target.adapter.project_platform_dir}/"
        if legacy and all(pattern.startswith(prefix) for pattern in legacy):
            ignore_base = gitignore.remove(ignore_base, tool.name)
    ignore_after = (
        gitignore.apply(ignore_base, block_name, patterns) if patterns else ignore_base
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
    for action in plan.files:
        if action.status == "unchanged":
            continue
        path = action.path
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(action.source, path)
        if action.executable:
            _make_executable(path)

    if plan.settings_changed:
        target.settings_path.parent.mkdir(parents=True, exist_ok=True)
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
    require_supported(tool, target)
    notes: list[str] = []
    removed_any = False

    for payload in tool.expand(target.platform):
        source, dest, _, _ = payload
        path = target.destination_path(payload.root, dest)
        if not path.is_file():
            continue
        if sha256(path) != sha256(source) and not force:
            notes.append(f"kept {dest} (modified since install)")
            continue
        path.unlink()
        _prune_empty_parents(path, target.destination_root(payload.root))
        removed_any = True

    fragment = substitute(tool.fragment_for(target.platform), target)
    if fragment:
        before = target.read_settings()
        healed = target.adapter.prepare_config(before, fragment)
        after = target.adapter.unmerge_config(healed, fragment)
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
        after = gitignore.remove(before, target.gitignore_block_name(tool.name))
        if not target.is_user:
            legacy = gitignore.block_patterns(after, tool.name)
            prefix = f"{target.adapter.project_platform_dir}/"
            if legacy and all(pattern.startswith(prefix) for pattern in legacy):
                after = gitignore.remove(after, tool.name)
        if after != before:
            removed_any = True
            if after.strip():
                target.gitignore_path.write_text(after, encoding="utf-8")
            else:
                target.gitignore_path.unlink(missing_ok=True)
                notes.append(f"removed now-empty {target.gitignore_path.name}")

    # Remove any platform roots made empty by this tool. ChatGPT uses separate
    # `.agents` and `.codex` trees, while Claude's logical roots are nested.
    roots = {target.install_root, *(target.destination_root(p.root) for p in tool.expand(target.platform))}
    for root in sorted(roots, key=lambda p: len(p.parts), reverse=True):
        current = root
        while current != target.scope_root and target.scope_root in current.parents:
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent

    if not removed_any and not notes:
        notes.append("nothing to remove")
    return notes
