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
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any


def main() -> int:
    args: list[str] = sys.argv[1:]
    if len(args) == 3 and args[1] == "--request":
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
        command = args[2:]
    else:
        return 2
    lock_path: str = args[0]

    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    started_at: str = time.strftime("%Y-%m-%dT%H:%M:%S")

    # The marker exists before the child: a poll racing the spawn must find the
    # session already alive.
    def write_marker(child_pid: int | None) -> None:
        with open(lock_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "agentId": os.environ.get("ABOARD_AGENT_ID"),
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
        # Order matters: the exit record has to be readable by the time the
        # marker's removal wakes the extension.
        write_exit(exit_code, spawn_error)
        try:
            os.remove(lock_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
