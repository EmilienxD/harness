"""aboard's launch wrapper: owns a lock-marker file for exactly the child's lifetime.

Usage:
    python aboard_wrapper.py <lock-file> -- <command> [args...]
    python aboard_wrapper.py <lock-file> --request <launch.json>

The extension launches every Claude session through this wrapper. A request
path is a one-time launch capability: it is claimed before it is read, so a
terminal-history replay cannot start or resume Claude again. The wrapper
creates the marker file before spawning the child Claude process, forwards the
terminal, waits, and removes the marker when the child exits for any reason —
`exit`, double Ctrl+C, an unhandled crash. The bridge polls the marker's
existence instead of a process id: no PID reuse risk and no process-table
scraping. A wrapper killed outright leaves a stale marker, but that path is
already settled by the terminal-close event, which untracks the agent first.

On Ctrl+C: every process in the console's foreground group receives the event,
the wrapper included. The wait loop swallows the interrupt and keeps waiting —
only the child decides whether one press clears the prompt or two exit, so the
marker survives a single Ctrl+C exactly as it must.

Beside the marker the wrapper leaves an exit record, `<agent-id>.exit`, written
*before* the marker is removed so whoever reacts to the removal finds it. It
carries the child's exit code, or the spawn error when the command could not be
run at all. A Claude CLI that dies before its TUI exists — bad flag, missing
binary, unresumable session id — reports through this file, since it never
reaches the point of firing a SessionStart hook.

Each aboard invocation also leaves one sanitized record under runtime `events`.
It proves which launch-shaping flags reached the wrapper without retaining the
command, prompt, session id, environment, or credentials. Records are immutable
per invocation, so a later resume cannot erase the evidence from the start.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from typing import Any


SAFE_FILE_TOKEN = re.compile(r"^[A-Za-z0-9._-]+$")


def chrome_flag(command: list[str]) -> str:
    enabled = command.count("--chrome")
    disabled = command.count("--no-chrome")
    if enabled and disabled:
        return "conflicting"
    if enabled:
        return "enabled"
    if disabled:
        return "disabled"
    return "absent"


def launch_kind(command: list[str]) -> str:
    if "--resume" in command:
        return "resume"
    if "--session-id" in command:
        return "start"
    return "unknown"


def write_launch_audit(path: str | None, record: dict[str, Any]) -> None:
    if path is None:
        return
    temporary_path = f"{path}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(record, handle)
        os.replace(temporary_path, path)
    except OSError:
        try:
            os.remove(temporary_path)
        except OSError:
            pass


def main() -> int:
    args: list[str] = sys.argv[1:]
    request_delivery: bool
    if len(args) == 3 and args[1] == "--request":
        request_delivery = True
        request_path: str = args[2]
        claimed_path: str = f"{request_path}.claimed-{os.getpid()}"
        try:
            # Same-directory rename is atomic: only one wrapper can claim this
            # launch capability, even when terminal history is replayed twice.
            os.replace(request_path, claimed_path)
            with open(claimed_path, "r", encoding="utf-8") as handle:
                request: Any = json.load(handle)
            loaded_command: Any = request.get("command") if isinstance(request, dict) else None
            if not isinstance(loaded_command, list) or not loaded_command or not all(
                isinstance(token, str) and token for token in loaded_command
            ):
                return 2
            command: list[str] = loaded_command
        except (OSError, json.JSONDecodeError):
            return 2
        finally:
            try:
                os.remove(claimed_path)
            except OSError:
                pass
    elif len(args) >= 3 and args[1] == "--":
        request_delivery = False
        command = args[2:]
    else:
        return 2
    lock_path: str = args[0]

    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    started_at: str = time.strftime("%Y-%m-%dT%H:%M:%S")
    agent_id = os.environ.get("ABOARD_AGENT_ID")
    audit_path: str | None = None
    if agent_id is not None and SAFE_FILE_TOKEN.fullmatch(agent_id):
        runtime_directory = os.path.dirname(os.path.dirname(os.path.abspath(lock_path)))
        audit_path = os.path.join(
            runtime_directory,
            "events",
            f"launch-{agent_id}-{os.getpid()}-{time.time_ns()}.json",
        )
    audit: dict[str, Any] = {
        "version": 1,
        "agentId": agent_id,
        "agentType": os.environ.get("ABOARD_AGENT_TYPE"),
        "startedAt": started_at,
        "delivery": "request" if request_delivery else "inline",
        "launchKind": launch_kind(command),
        "chromeFlag": chrome_flag(command),
        "agentDefinition": "--agent" in command,
        "disableSlashCommands": "--disable-slash-commands" in command,
        "commandTokenCount": len(command),
        "childSpawned": False,
        "exitCode": None,
        "spawnFailed": False,
    }
    write_launch_audit(audit_path, audit)

    # The marker exists before the child: a poll racing the spawn must find the
    # session already alive.
    def write_marker(child_pid: int | None) -> None:
        with open(lock_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "agentId": agent_id,
                    "sessionId": os.environ.get("ABOARD_SESSION_ID"),
                    "wrapperPid": os.getpid(),
                    "childPid": child_pid,
                    "startedAt": started_at,
                },
                handle,
            )

    exit_path: str = os.path.splitext(lock_path)[0] + ".exit"

    def write_exit(exit_code: int | None, error: str | None = None) -> None:
        record: dict[str, Any] = {
            "agentId": os.environ.get("ABOARD_AGENT_ID"),
            "sessionId": os.environ.get("ABOARD_SESSION_ID"),
            "exitCode": exit_code,
            "endedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        if error is not None:
            record["error"] = error
        try:
            with open(exit_path, "w", encoding="utf-8") as handle:
                json.dump(record, handle)
        except OSError:
            # Diagnostics must never become the reason a session fails to settle.
            pass

    write_marker(None)
    exit_code: int | None = None
    spawn_error: str | None = None
    try:
        try:
            child = subprocess.Popen(command)
        except OSError as error:
            # The command itself could not be run: the shell found the wrapper
            # but not Claude. Nothing else will ever report this.
            spawn_error = str(error)
            exit_code = 127
            return exit_code
        audit["childSpawned"] = True
        write_launch_audit(audit_path, audit)
        write_marker(child.pid)
        while True:
            try:
                exit_code = child.wait()
                return exit_code
            except KeyboardInterrupt:
                # Ctrl+C reached the wrapper too; the child decides whether to
                # exit. Keep owning the marker until it does.
                if child.poll() is not None:
                    exit_code = child.returncode
                    return exit_code
    finally:
        audit["exitCode"] = exit_code
        audit["spawnFailed"] = spawn_error is not None
        write_launch_audit(audit_path, audit)
        # Order matters: the exit record has to be readable by the time the
        # marker's removal wakes the extension.
        write_exit(exit_code, spawn_error)
        try:
            os.remove(lock_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
