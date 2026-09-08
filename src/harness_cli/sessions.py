"""Standalone visible-terminal sessions and durable ask/reply relationships."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any


class SessionError(RuntimeError):
    pass


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".harness"


def _connect() -> sqlite3.Connection:
    root = state_dir()
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(root / "sessions.sqlite3", timeout=30)
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            claude_session_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL REFERENCES sessions(id),
            child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
            state TEXT NOT NULL CHECK(state IN ('pending', 'replied')),
            reply TEXT,
            delivery_id TEXT UNIQUE,
            claimed_at TEXT,
            acknowledged_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS requests_parent_state
            ON requests(parent_session_id, state, acknowledged_at, claimed_at, created_at);
        """
    )
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


def _command_from_config(config: dict[str, Any]) -> list[str]:
    command = config.get("claudeCommand", ["claude"])
    command = _command(command, "claudeCommand")
    executable = Path(command[0]).expanduser()
    if shutil.which(command[0]) is None and not executable.is_file():
        raise SessionError(f"Claude command is not available: {command[0]}")
    return command


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


def _register(session_id: str, cwd: Path) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT INTO sessions(id, claude_session_id, cwd) VALUES (?, ?, ?)",
            (session_id, session_id, str(cwd.resolve())),
        )


def launch(prompt: str | None = None, cwd: Path | None = None) -> str:
    session_id = str(uuid.uuid4())
    selected_cwd = (cwd or Path.cwd()).resolve()
    _register(session_id, selected_cwd)
    try:
        environment = os.environ.copy()
        environment["HARNESS_SESSION_ID"] = session_id
        command = [*_command_from_config(_config()), "--session-id", session_id]
        if prompt:
            command.append(prompt)
        _visible_terminal(command, environment, selected_cwd)
    except Exception:
        with _connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        raise
    return session_id


def ask(prompt: str) -> tuple[str, str]:
    parent_id = os.environ.get("HARNESS_SESSION_ID")
    if not parent_id:
        raise SessionError("harness ask must run inside a session started by harness run or resume")
    request_id = str(uuid.uuid4())
    child_id = str(uuid.uuid4())
    selected_cwd = Path.cwd().resolve()
    environment = os.environ.copy()
    environment.update(
        {
            "HARNESS_SESSION_ID": child_id,
            "HARNESS_REQUEST_ID": request_id,
        }
    )
    command = [*_command_from_config(_config()), "--session-id", child_id, prompt]
    with _connect() as connection:
        parent = connection.execute("SELECT 1 FROM sessions WHERE id = ?", (parent_id,)).fetchone()
        if parent is None:
            raise SessionError("the current Harness parent session is not registered")
        connection.execute(
            "INSERT INTO sessions(id, claude_session_id, cwd) VALUES (?, ?, ?)",
            (child_id, child_id, str(selected_cwd)),
        )
        connection.execute(
            "INSERT INTO requests(id, parent_session_id, child_session_id, state) VALUES (?, ?, ?, 'pending')",
            (request_id, parent_id, child_id),
        )
    try:
        _visible_terminal(command, environment, selected_cwd)
    except Exception:
        with _connect() as connection:
            connection.execute("DELETE FROM requests WHERE id = ?", (request_id,))
            connection.execute("DELETE FROM sessions WHERE id = ?", (child_id,))
        raise
    return request_id, child_id


def reply(message: str) -> str:
    child_id = os.environ.get("HARNESS_SESSION_ID")
    request_id = os.environ.get("HARNESS_REQUEST_ID")
    if not child_id or not request_id:
        raise SessionError("harness reply must run inside a child created by harness ask")
    delivery_id = str(uuid.uuid4())
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE requests SET state = 'replied', reply = ?, delivery_id = ?
            WHERE id = ? AND child_session_id = ? AND state = 'pending'
            """,
            (message, delivery_id, request_id, child_id),
        )
        if cursor.rowcount != 1:
            raise SessionError("this request is unknown or has already been answered")
    return delivery_id


def resume(session_id: str) -> None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT claude_session_id, cwd FROM sessions WHERE id = ?", (session_id,)
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
    command = [*_command_from_config(_config()), "--resume", row[0]]
    _visible_terminal(command, environment, Path(row[1]))
