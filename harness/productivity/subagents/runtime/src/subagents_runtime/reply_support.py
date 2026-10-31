"""Project-local reply resources for delegated interactive conversations.

No provider home, trust, permission or instruction settings are changed here.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from subagents_runtime.storage import connect, state_dir
from subagents_runtime.sessions import SessionError


class ReplySupportUnavailable(SessionError):
    """A process may exist, but its pending request must not wait for a reply."""


def payload_root() -> Path:
    bundled = Path(__file__).parent / "resources" / "reply-support"
    if bundled.is_dir():
        return bundled
    source = Path(__file__).resolve().parents[3]
    if (source / "reply-to-agent" / "SKILL.md").is_file():
        return source
    raise ValueError("Subagents runtime is missing its bundled reply support")


def _write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _check_target(cwd: Path, path: Path) -> None:
    for part in (path, *path.parents):
        if part == cwd:
            break
        if part.is_symlink():
            raise ValueError(f"Reply support cannot modify a linked path: {part}")


def _copy(source: Path, target: Path) -> None:
    content = source.read_bytes()
    if target.exists():
        if target.read_bytes() != content:
            raise ValueError(f"Conflicting reply support at {target}; update it explicitly before launching")
        return
    _write(target, content)


def acknowledge(cwd: Path, provider: str) -> None:
    """Called only by the loaded native integration, never the process launcher."""
    execution = os.environ.get("HARNESS_EXECUTION_ID")
    if not execution or os.environ.get("HARNESS_EXECUTION_MODE") != "interactive":
        return
    from subagents_runtime.roles import find_skill

    names = ["reply-to-agent"] if provider == "pi" else ["reply-to-agent", "reply-to-agent-with-previous-message"]
    if all(find_skill(cwd, provider, name) for name in names):
        _write(state_dir() / "runtime/reply-ready" / execution, provider.encode())


def is_ready(execution: str, provider: str) -> bool:
    """Observe readiness without imposing a deadline on provider initialization."""
    path = state_dir() / "runtime/reply-ready" / execution
    return path.is_file() and path.read_text() == provider


def prepare(cwd: Path, provider: str) -> None:
    """Serialize preparation across launchers; never replace unowned payloads."""
    from subagents_runtime.sessions import SessionError

    try:
        source = payload_root()
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            skill_root = cwd / {"claude": ".claude", "chatgpt": ".agents", "pi": ".pi"}[provider] / "skills"
            names = ["reply-to-agent"]
            if provider != "pi":
                names.append("reply-to-agent-with-previous-message")
            # Validate collisions before writing any skill payload.
            copies = []
            for name in names:
                copies.append((source / name / "SKILL.md", skill_root / name / "SKILL.md"))
                if provider == "chatgpt":
                    copies.append((source / name / "chatgpt" / "openai.yaml", skill_root / name / "agents" / "openai.yaml"))
            for origin, target in copies:
                _check_target(cwd, target)
                if target.exists() and target.read_bytes() != origin.read_bytes():
                    raise ValueError(f"Conflicting reply support at {target}; update it explicitly before launching")
            if provider == "pi":
                # Native installed packages already contain the extension and transport.
                installed = cwd / ".pi/npm/node_modules/harness-pi-subagents"
                agent = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent")))
                user_installed = agent / "npm/node_modules/harness-pi-subagents"
                if not installed.is_dir() and not user_installed.is_dir():
                    copies.extend([
                        (source / "pi/extension.ts", cwd / ".pi/extensions/harness-subagents/index.ts"),
                        ((source / "pi/transport.ts") if (source / "pi/transport.ts").is_file() else source.parents[1] / "internal/pi-transport/transport.ts", cwd / ".pi/harness/pi-transport/transport.ts"),
                    ])
            else:
                path = cwd / (".claude/settings.json" if provider == "claude" else ".codex/hooks.json")
                _check_target(cwd, path)
                settings = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
                if not isinstance(settings, dict) or not isinstance(settings.get("hooks", {}), dict):
                    raise ValueError(f"Invalid provider hooks at {path}")
                if settings.get("disableAllHooks"):
                    raise ValueError(f"Provider hooks are disabled at {path}")
                fragment = json.loads((source / provider / ("settings.fragment.json" if provider == "claude" else "hooks.fragment.json")).read_text(encoding="utf-8"))
                hooks = settings.setdefault("hooks", {})
                home = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) if provider == "claude" else Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
                user_path = home / ("settings.json" if provider == "claude" else "hooks.json")
                user_settings = json.loads(user_path.read_text(encoding="utf-8")) if user_path.is_file() else {}
                user_hooks = user_settings.get("hooks", {}) if isinstance(user_settings, dict) else {}
                for event, groups in fragment["hooks"].items():
                    existing = hooks.setdefault(event, [])
                    if not isinstance(existing, list):
                        raise ValueError(f"Invalid {event} hooks at {path}")
                    inherited = user_hooks.get(event, []) if isinstance(user_hooks, dict) else []
                    if not isinstance(inherited, list):
                        inherited = []
                    if any("harness-subagents-hook" in json.dumps(group) or "subagents_runtime.hooks" in json.dumps(group) for group in [*existing, *inherited]):
                        continue
                    for group in groups:
                        for hook in group["hooks"]:
                            if provider == "claude":
                                hook.update(command=sys.executable, args=["-m", "subagents_runtime.hooks", "--claude"])
                            else:
                                if " " in sys.executable:
                                    raise ValueError("Codex reply hooks require a Python executable path without spaces")
                                hook["command"] = f"{Path(sys.executable).as_posix()} -m subagents_runtime.hooks --chatgpt"
                        existing.append(group)
                encoded = (json.dumps(settings, indent=2) + "\n").encode()
                if not path.exists() or json.loads(path.read_text(encoding="utf-8")) != settings:
                    _write(path, encoded)
            for origin, target in copies:
                _check_target(cwd, target)
                if target.exists() and target.read_bytes() != origin.read_bytes():
                    raise ValueError(f"Conflicting reply support at {target}; update it explicitly before launching")
            for origin, target in copies:
                _copy(origin, target)
    except (OSError, ValueError) as exc:
        raise SessionError(f"Reply support unavailable for {provider} in {cwd}: {exc}") from exc
