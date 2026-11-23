"""Read-only prerequisites for interactive replies; only the installer provisions resources."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from subagents_runtime.storage import state_dir
from subagents_runtime.sessions import SessionError


class ReplySupportUnavailable(SessionError):
    """An interactive launch lacks its reply integration."""


def _write(path: Path, content: bytes) -> None:
    """Atomically persist runtime state, never provider resources."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _settings(path: Path) -> dict:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"Invalid settings at {path}")
    return value


def available(cwd: Path, provider: str) -> bool:
    if provider == "pi":
        from subagents_runtime.roles import pi_package_skill

        return pi_package_skill(cwd, "reply-to-agent", require_extensions=True) is not None
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) if provider == "claude" else Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    # Integration prerequisites belong to this launch root or user scope. Native skill
    # discovery may walk ancestors, but that does not establish hooks at this cwd.
    skill_roots = (
        cwd / (".claude/skills" if provider == "claude" else ".agents/skills"),
        (home if provider == "claude" else Path.home() / ".agents") / "skills",
    )
    if not all(any((root / name / "SKILL.md").is_file() for root in skill_roots)
               for name in ("reply-to-agent", "reply-to-agent-with-previous-message")):
        return False
    paths = [
        home / ("settings.json" if provider == "claude" else "hooks.json"),
        cwd / (".claude/settings.json" if provider == "claude" else ".codex/hooks.json"),
    ]
    if provider == "claude":
        paths.append(cwd / ".claude/settings.local.json")
    disabled = False
    events: set[str] = set()
    for path in paths:
        settings = _settings(path)
        disabled = settings.get("disableAllHooks", disabled)
        hooks = settings.get("hooks", {})
        if not isinstance(hooks, dict):
            return False
        for event, groups in hooks.items():
            if "harness-subagents-hook" in json.dumps(groups) or "subagents_runtime.hooks" in json.dumps(groups):
                events.add(event)
    required = {"SessionStart", "UserPromptSubmit", "Stop"}
    if provider == "claude":
        required.add("UserPromptExpansion")
    return not disabled and required <= events


def _pi_pending_install(cwd: Path) -> bool:
    """Allow Pi to hydrate an installer-managed package on native startup."""
    from subagents_runtime.roles import pi_agent_directory

    package_name = "harness-pi-subagents"
    prefix = f"npm:{package_name}@file:"
    for root in (cwd.resolve() / ".pi", pi_agent_directory()):
        for entry in _settings(root / "settings.json").get("packages", []):
            source = entry.get("source") if isinstance(entry, dict) else entry
            if not isinstance(source, str) or source.split("@", 1)[0] != f"npm:{package_name}":
                continue
            # Project declarations take precedence. Do not assume filtered resources load.
            if not source.startswith(prefix):
                return False
            if isinstance(entry, dict) and (
                entry.get("autoload") is False or "skills" in entry or "extensions" in entry
            ):
                return False
            archive = Path(source.removeprefix(prefix))
            return (
                archive.is_absolute()
                and archive.is_file()
                and not (root / "npm/node_modules" / package_name).exists()
            )
    return False


def validate(cwd: Path, provider: str) -> None:
    """Reject missing prerequisites before selecting or starting an execution backend."""
    try:
        if available(cwd, provider) or (provider == "pi" and _pi_pending_install(cwd)):
            return
    except (OSError, ValueError, TypeError):
        pass
    command = f'uvx --from git+https://github.com/EmilienxD/harness harness install subagents --platform {provider} --root "{cwd}"'
    raise SessionError(
        f"Cannot launch a subagent in `{cwd}`:\n"
        f"Subagents integration is unavailable. Install the subagents tool with {command}.\n\n"
        "No subagent was started."
    )


def acknowledge(cwd: Path, provider: str) -> None:
    """Called only by the loaded native integration, never the process launcher."""
    execution = os.environ.get("HARNESS_EXECUTION_ID")
    if not execution or os.environ.get("HARNESS_EXECUTION_MODE") != "interactive":
        return
    if available(cwd, provider):
        _write(state_dir() / "runtime/reply-ready" / execution, provider.encode())


def is_ready(execution: str, provider: str) -> bool:
    path = state_dir() / "runtime/reply-ready" / execution
    return path.is_file() and path.read_text() == provider
