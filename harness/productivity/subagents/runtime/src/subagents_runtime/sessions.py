"""Standalone visible-terminal sessions and durable ask/reply relationships."""

from __future__ import annotations

import json
import math
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class SessionError(RuntimeError):
    pass


class _Connection(sqlite3.Connection):
    """`with connection` is only a transaction scope in sqlite3; also release the handle."""

    def __exit__(self, *arguments: object) -> bool | None:
        try:
            return super().__exit__(*arguments)
        finally:
            self.close()


# A blocking parent Stop polls for hours; reapplying the schema on every poll is
# pure churn once this process has already reconciled that database file.
_RECONCILED: set[Path] = set()


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".harness"


def _connect() -> sqlite3.Connection:
    root = state_dir()
    root.mkdir(parents=True, exist_ok=True)
    database = root / "sessions.sqlite3"
    reconciled = database in _RECONCILED and database.is_file()
    connection = sqlite3.connect(database, timeout=30, factory=_Connection)
    connection.execute("PRAGMA foreign_keys=ON")
    if reconciled:
        return connection
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            claude_session_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'claude',
            execution_mode TEXT NOT NULL DEFAULT 'interactive',
            hook_sequence INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS grants (
            id TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL REFERENCES sessions(id),
            skill TEXT NOT NULL,
            task TEXT NOT NULL,
            modes TEXT NOT NULL,
            provider TEXT NOT NULL,
            original_cwd TEXT NOT NULL,
            inbox TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('open', 'used', 'closed')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            closed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL REFERENCES sessions(id),
            child_session_id TEXT UNIQUE REFERENCES sessions(id),
            grant_id TEXT REFERENCES grants(id),
            agent_number INTEGER,
            source_name TEXT,
            task TEXT,
            provider TEXT,
            mode TEXT,
            prompt_hash TEXT,
            state TEXT NOT NULL CHECK(state IN ('launching', 'pending', 'succeeded', 'failed', 'cancelled', 'replied')),
            reply TEXT,
            delivery_id TEXT UNIQUE,
            reason TEXT,
            claim_sequence INTEGER,
            acknowledgement_sequence INTEGER,
            claimed_at TEXT,
            acknowledged_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    request_sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'requests'"
    ).fetchone()[0]
    if "'launching'" not in request_sql:
        connection.executescript(
            """
            PRAGMA foreign_keys=OFF;
            DROP INDEX IF EXISTS requests_parent_state;
            ALTER TABLE requests RENAME TO requests_legacy;
            CREATE TABLE requests (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT NOT NULL REFERENCES sessions(id),
                child_session_id TEXT UNIQUE REFERENCES sessions(id),
                grant_id TEXT REFERENCES grants(id),
                agent_number INTEGER,
                source_name TEXT,
                task TEXT,
                provider TEXT,
                mode TEXT,
                prompt_hash TEXT,
                state TEXT NOT NULL CHECK(state IN ('launching', 'pending', 'succeeded', 'failed', 'cancelled', 'replied')),
                reply TEXT,
                delivery_id TEXT UNIQUE,
                reason TEXT,
                claim_sequence INTEGER,
                acknowledgement_sequence INTEGER,
                claimed_at TEXT,
                acknowledged_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO requests(
                id, parent_session_id, child_session_id, state, reply, delivery_id,
                claimed_at, acknowledged_at, created_at
            )
            SELECT id, parent_session_id, child_session_id,
                CASE state WHEN 'replied' THEN 'succeeded' ELSE state END,
                reply, delivery_id, claimed_at, acknowledged_at, created_at
            FROM requests_legacy;
            DROP TABLE requests_legacy;
            PRAGMA foreign_keys=ON;
            """
        )
    session_columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    for name, declaration in {
        "provider": "TEXT NOT NULL DEFAULT 'claude'",
        "execution_mode": "TEXT NOT NULL DEFAULT 'interactive'",
        "hook_sequence": "INTEGER NOT NULL DEFAULT 0",
    }.items():
        if name not in session_columns:
            connection.execute(f"ALTER TABLE sessions ADD COLUMN {name} {declaration}")
    request_columns = {row[1] for row in connection.execute("PRAGMA table_info(requests)")}
    for name, declaration in {
        "grant_id": "TEXT REFERENCES grants(id)",
        "agent_number": "INTEGER",
        "source_name": "TEXT",
        "task": "TEXT",
        "provider": "TEXT",
        "mode": "TEXT",
        "prompt_hash": "TEXT",
        "reason": "TEXT",
        "claim_sequence": "INTEGER",
        "acknowledgement_sequence": "INTEGER",
    }.items():
        if name not in request_columns:
            connection.execute(f"ALTER TABLE requests ADD COLUMN {name} {declaration}")
    connection.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS requests_grant_source
            ON requests(grant_id, source_name) WHERE grant_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS requests_parent_state
            ON requests(parent_session_id, state, acknowledged_at, claimed_at, created_at);
        CREATE TABLE IF NOT EXISTS reply_authorizations (
            request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
            child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
            armed_sequence INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    _RECONCILED.add(database)
    return connection


def _config() -> dict[str, Any]:
    path = state_dir() / "config.json"
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionError(f"invalid Harness config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SessionError(f"Harness config {path} must be a JSON object")
    return value


def launch_configuration(cwd: Path) -> dict[str, Any]:
    """Resolve the version-2 project, global, then built-in launch configuration."""
    project = cwd.resolve() / ".harness" / "launch.json"
    global_path = state_dir() / "launch.json"
    for path in (project, global_path):
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SessionError(f"invalid Harness launch configuration {path}: {exc}") from exc
        if not isinstance(value, dict) or value.get("version") != 2:
            raise SessionError(f"Harness launch configuration {path} must be a version-2 JSON object")
        stop_wait = value.get("stopWaitHours")
        if stop_wait is not None and (
            isinstance(stop_wait, bool)
            or not isinstance(stop_wait, (int, float))
            or not math.isfinite(stop_wait)
            or stop_wait < 0
        ):
            raise SessionError(f"Harness launch configuration {path} stopWaitHours must be a non-negative finite number")
        return value
    return {"version": 2, "platform": "claude"}


def _split_command(value: str) -> list[str]:
    if os.name != "nt":
        return shlex.split(value)
    # posix=False preserves Windows path separators, but also preserves the
    # quotes around a token. Popen expects the unquoted argv value.
    return [
        token[1:-1] if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'" else token
        for token in shlex.split(value, posix=False)
    ]


def _command(value: object, setting: str) -> list[str]:
    command = _split_command(value) if isinstance(value, str) else value
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) and part.strip() for part in command)
    ):
        raise SessionError(f"{setting} must be a non-empty string or array of non-empty strings")
    # Arrays are argv, not a shell-ish representation. Preserve each token
    # byte-for-byte after validation; spaces can be intentional inside one arg.
    return list(command)


def _command_from_config(config: dict[str, Any], provider: str = "claude") -> list[str]:
    setting = "chatgptCommand" if provider == "chatgpt" else "claudeCommand"
    selected = config.get("command") if config.get("platform") == provider else None
    command = selected if selected is not None else config.get(setting, ["codex"] if provider == "chatgpt" else ["claude"])
    command = _command(command, setting)
    executable = Path(command[0]).expanduser()
    if shutil.which(command[0]) is None and not executable.is_file():
        raise SessionError(f"{provider} command is not available: {command[0]}")
    return command


def _provider_command(config: dict[str, Any], provider: str) -> list[str]:
    # Keep the established Claude seam one-argument-compatible for wrappers
    # and tests; only the new ChatGPT branch needs the selector.
    return _command_from_config(config) if provider == "claude" else _command_from_config(config, provider)


def _harness_environment(environment: dict[str, str]) -> dict[str, str]:
    """Values a separately launched terminal cannot safely be assumed to inherit."""
    return {
        key: value
        for key, value in environment.items()
        if key.startswith("HARNESS_")
    }


def _powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _powershell_command(argv: list[str]) -> str:
    return "& " + " ".join(_powershell_literal(part) for part in argv)


def _macos_terminal_command(argv: list[str], environment: dict[str, str], cwd: Path) -> str:
    exported = ["env", *(f"{key}={value}" for key, value in _harness_environment(environment).items()), *argv]
    return f"cd {shlex.quote(str(cwd))} && {shlex.join(exported)}"


def _apple_script_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _visible_terminal(argv: list[str], environment: dict[str, str], cwd: Path) -> None:
    config = _config()
    explicit = config.get("terminalCommand")
    if explicit is not None:
        prefix = _command(explicit, "terminalCommand")
        subprocess.Popen([*prefix, *argv], env=environment, cwd=cwd, start_new_session=True)
        return

    tried: list[str] = []
    if os.name == "nt":
        tried.append("Windows Terminal (wt.exe)")
        if terminal := shutil.which("wt.exe"):
            subprocess.Popen([terminal, "new-tab", "--", *argv], env=environment, cwd=cwd)
            return
        tried.append("Windows console (powershell.exe)")
        if shell := shutil.which("powershell.exe"):
            flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            subprocess.Popen([shell, "-NoExit", "-Command", _powershell_command(argv)], env=environment, cwd=cwd, creationflags=flags)
            return
    elif sys.platform == "darwin":
        tried.append("Terminal.app (osascript)")
        if script := shutil.which("osascript"):
            command = _apple_script_literal(_macos_terminal_command(argv, environment, cwd))
            subprocess.Popen([script, "-e", f'tell application "Terminal" to do script "{command}"'], cwd=cwd, start_new_session=True)
            return
    else:
        candidates = (
            ("x-terminal-emulator", ["-e"]),
            ("gnome-terminal", ["--"]),
            ("konsole", ["-e"]),
            ("xterm", ["-e"]),
        )
        for name, args in candidates:
            tried.append(name)
            if terminal := shutil.which(name):
                subprocess.Popen([terminal, *args, *argv], env=environment, cwd=cwd, start_new_session=True)
                return
    raise SessionError("could not open a visible terminal; tried: " + ", ".join(tried))


def _register(
    session_id: str,
    cwd: Path,
    provider: str = "claude",
    execution_mode: str = "interactive",
) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT INTO sessions(id, claude_session_id, cwd, provider, execution_mode) VALUES (?, ?, ?, ?, ?)",
            (session_id, session_id, str(cwd.resolve()), provider, execution_mode),
        )


def register_observed(
    session_id: str,
    cwd: Path,
    provider: str,
    execution_mode: str = "interactive",
) -> None:
    if provider not in {"claude", "chatgpt"}:
        raise SessionError(f"unsupported provider {provider!r}")
    if execution_mode not in {"interactive", "auto", "auto-run"}:
        raise SessionError(f"unsupported execution mode {execution_mode!r}")
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO sessions(id, claude_session_id, cwd, provider, execution_mode)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                execution_mode = excluded.execution_mode
            """,
            (session_id, session_id, str(cwd.resolve()), provider, execution_mode),
        )


def bind_observed(
    runtime_session_id: str,
    cwd: Path,
    provider: str,
    execution_mode: str = "interactive",
) -> str:
    """Bind a runtime-assigned provider id to the stable Harness identity."""
    stable_id = os.environ.get("HARNESS_SESSION_ID")
    with _connect() as connection:
        if stable_id and connection.execute("SELECT 1 FROM sessions WHERE id = ?", (stable_id,)).fetchone():
            connection.execute(
                "UPDATE sessions SET claude_session_id = ?, provider = ?, execution_mode = ? WHERE id = ?",
                (runtime_session_id, provider, execution_mode, stable_id),
            )
            return stable_id
    register_observed(runtime_session_id, cwd, provider, execution_mode)
    return runtime_session_id


def launch(
    prompt: str | None = None,
    cwd: Path | None = None,
    *,
    provider: str = "claude",
) -> str:
    session_id = str(uuid.uuid4())
    selected_cwd = (cwd or Path.cwd()).resolve()
    _register(session_id, selected_cwd, provider)
    try:
        environment = os.environ.copy()
        environment["HARNESS_SESSION_ID"] = session_id
        command = [*_provider_command(launch_configuration(selected_cwd), provider)]
        if provider == "claude":
            command.extend(["--session-id", session_id])
        if prompt:
            if provider == "chatgpt":
                command.append("--")
            command.append(prompt)
        _visible_terminal(command, environment, selected_cwd)
    except Exception:
        with _connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        raise
    return session_id


def launch_delegated(request, request_id: str, agent_number: int, cwd: Path) -> str:
    """Launch a validated request; the request file remains the prompt source."""
    child_id = str(uuid.uuid4())
    environment = os.environ.copy()
    environment.update({
        "HARNESS_SESSION_ID": child_id,
        "HARNESS_REQUEST_ID": request_id,
        "HARNESS_EXECUTION_MODE": request.mode,
        "HARNESS_PROVIDER": request.provider,
    })
    if aboard_session := _launch_through_aboard(request, request_id, cwd):
        return aboard_session
    command = [*_provider_command(launch_configuration(cwd), request.provider)]
    skill = {
        "prototype": "prototype",
        "websearch": "websearch",
        "brainstorm": "grill-me",
        "implement": "address-this",
        "review": "review-this",
    }.get(request.task)
    prompt = request.prompt if skill is None else f"{'$' if request.provider == 'chatgpt' else '/'}{skill}\n\n{request.prompt}"
    if request.provider == "claude":
        command.extend(["--session-id", child_id])
        if request.task == "explore":
            command.extend(["--agent", "Explore"])
    elif request.task == "explore":
        command.extend(["--sandbox", "read-only", "--ask-for-approval", "never"])
    if request.provider == "chatgpt":
        command.append("--")
    command.append(prompt)
    _register(child_id, cwd, request.provider, request.mode)
    try:
        _visible_terminal(command, environment, cwd.resolve())
    except Exception:
        with _connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (child_id,))
        raise
    return child_id


def _endpoint_directory() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "abd" / "endpoints"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "abd" / "endpoints"
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "abd" / "endpoints"


def _path_contains(root: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _discover_delegation_endpoint(cwd: Path) -> tuple[str, int, str] | None:
    inherited_port = os.environ.get("ABOARD_BRIDGE_PORT")
    inherited_token = os.environ.get("ABOARD_BRIDGE_TOKEN")
    if inherited_port is not None or inherited_token is not None:
        if not inherited_port or not inherited_token:
            raise SessionError("inherited Aboard authentication is incomplete")
        try:
            return "127.0.0.1", int(inherited_port), inherited_token
        except ValueError as exc:
            raise SessionError("inherited Aboard bridge port is invalid") from exc
    directory = _endpoint_directory()
    try:
        entries = list(directory.glob("*.json"))
    except OSError:
        return None
    candidates: list[tuple[str, int, str, str]] = []
    for path in entries:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if (
                record.get("version") == 2
                and record.get("host") == "127.0.0.1"
                and isinstance(record.get("port"), int)
                and isinstance(record.get("delegationToken"), str)
                and isinstance(record.get("workspaceRoot"), str)
                and isinstance(record.get("pid"), int)
                and _process_alive(record["pid"])
                and _path_contains(Path(record["workspaceRoot"]), cwd)
            ):
                candidates.append((record["host"], record["port"], record["delegationToken"], str(record.get("activatedAt", ""))))
        except (OSError, ValueError, TypeError):
            continue
    if not candidates:
        return None
    host, port, token, _activated = max(candidates, key=lambda item: item[3])
    return host, port, token


def _launch_through_aboard(request, request_id: str, cwd: Path) -> str | None:
    endpoint = _discover_delegation_endpoint(cwd)
    if endpoint is None:
        return None
    body = json.dumps({
        "requestId": request_id,
        "task": request.task,
        "provider": request.provider,
        "mode": request.mode,
        "prompt": request.prompt,
        "cwd": str(cwd.resolve()),
    }).encode("utf-8")
    result = None
    for attempt in range(2):
        host, port, token = endpoint
        http_request = urllib.request.Request(
            f"http://{host}:{port}/delegations",
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 401 or attempt != 0 or os.environ.get("ABOARD_BRIDGE_TOKEN"):
                raise SessionError(f"Aboard delegation launch failed with HTTP {exc.code}") from None
            refreshed = _discover_delegation_endpoint(cwd)
            if refreshed is None:
                raise SessionError("Aboard delegation endpoint authentication expired") from None
            endpoint = refreshed
        except (OSError, ValueError) as exc:
            raise SessionError("Aboard delegation endpoint could not launch the request") from exc
    session_id = result.get("sessionId") if isinstance(result, dict) else None
    if not isinstance(session_id, str) or not session_id:
        raise SessionError("Aboard delegation endpoint returned an invalid launch result")
    return session_id


def resume(session_id: str) -> None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT claude_session_id, cwd, provider FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        request = connection.execute(
            "SELECT id FROM requests WHERE child_session_id = ?",
            (session_id,),
        ).fetchone()
    if row is None:
        raise SessionError(f"unknown Harness session {session_id}")
    environment = os.environ.copy()
    environment["HARNESS_SESSION_ID"] = session_id
    if request:
        environment["HARNESS_REQUEST_ID"] = request[0]
    command = [*_provider_command(launch_configuration(Path(row[1])), row[2])]
    command.extend(["resume", row[0]] if row[2] == "chatgpt" else ["--resume", row[0]])
    _visible_terminal(command, environment, Path(row[1]))
