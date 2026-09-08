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


class SessionError(RuntimeError):
    pass


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".harness"


def _connect() -> sqlite3.Connection:
    root = state_dir()
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(root / "sessions.sqlite3", timeout=30)
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
            child_session_id TEXT NOT NULL REFERENCES sessions(id),
            state TEXT NOT NULL CHECK(state IN ('pending', 'replied')),
            reply TEXT,
            delivery_id TEXT UNIQUE,
            claimed_at TEXT,
            acknowledged_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    return connection


def _config() -> dict:
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


def _command_from_config(config: dict) -> list[str]:
    command = config.get("claudeCommand", ["claude"])
    if isinstance(command, str):
        command = shlex.split(command, posix=os.name != "nt")
    if not isinstance(command, list) or not command or not all(isinstance(part, str) and part for part in command):
        raise SessionError("claudeCommand must be a non-empty string or array of strings")
    executable = Path(command[0]).expanduser()
    if shutil.which(command[0]) is None and not executable.is_file():
        raise SessionError(f"Claude command is not available: {command[0]}")
    return command


def _visible_terminal(argv: list[str], environment: dict[str, str], cwd: Path) -> None:
    config = _config()
    explicit = config.get("terminalCommand")
    if explicit is not None:
        prefix = shlex.split(explicit, posix=os.name != "nt") if isinstance(explicit, str) else explicit
        if not isinstance(prefix, list) or not prefix or not all(isinstance(part, str) for part in prefix):
            raise SessionError("terminalCommand must be a non-empty string or array of strings")
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
            subprocess.Popen([shell, "-NoExit", "-Command", subprocess.list2cmdline(argv)], env=environment, cwd=cwd, creationflags=flags)
            return
    elif sys.platform == "darwin":
        tried.append("Terminal.app (osascript)")
        if script := shutil.which("osascript"):
            command = f"cd {shlex.quote(str(cwd))} && {shlex.join(argv)}".replace("\\", "\\\\").replace('"', '\\"')
            subprocess.Popen([script, "-e", f'tell application "Terminal" to do script "{command}"'], env=environment, cwd=cwd, start_new_session=True)
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
    command = [*_command_from_config(_config()), "--session-id", child_id, prompt]
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
            "SELECT id FROM requests WHERE child_session_id = ? ORDER BY created_at DESC LIMIT 1",
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
