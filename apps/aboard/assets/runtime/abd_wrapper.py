"""aboard's launch wrapper: owns a lock-marker file for exactly the child's lifetime.

Usage:
    python abd_wrapper.py <lock-file> -- <command> [args...]
    python abd_wrapper.py <lock-file> --request <launch.json>

The extension launches every supported agent session through this wrapper. A request
path is a one-time launch capability: it is claimed before it is read, so a
terminal-history replay cannot start or resume Claude again. The wrapper
creates the marker file before spawning the child agent process, forwards the
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
run at all. A Claude CLI that dies before its TUI exists; bad flag, missing
binary, unresumable session id; reports through this file, since it never
reaches the point of firing a SessionStart hook.

"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Any


def _npm_shim_command(shim: str, args: list[str]) -> list[str] | None:
    """Translate a standard npm cmd-shim into a native Node invocation."""
    try:
        with open(shim, encoding="utf-8") as handle:
            contents = handle.read(65_537)
    except (OSError, UnicodeError):
        return None
    if len(contents) > 65_536:
        return None
    match = re.search(
        r'&\s+"%_prog%"\s+"%dp0%\\([^"\r\n]+\.js)"\s+%\*\s*$',
        contents,
        flags=re.IGNORECASE | re.MULTILINE,
    )
    if match is None:
        return None
    shim_root = os.path.realpath(os.path.dirname(shim))
    entry = os.path.realpath(os.path.join(shim_root, *match.group(1).split("\\")))
    try:
        if os.path.commonpath((shim_root, entry)) != shim_root or not os.path.isfile(entry):
            return None
    except ValueError:
        return None
    local_node = os.path.join(shim_root, "node.exe")
    node = local_node if os.path.isfile(local_node) else shutil.which("node.exe")
    if node is None:
        return None
    return [node, entry, *args]


def _native_executable(command: str) -> str | None:
    if os.path.isabs(command) or os.path.dirname(command):
        return None
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        for suffix in (".exe", ".com"):
            candidate = os.path.join(directory, f"{command}{suffix}")
            if os.path.isfile(candidate):
                return candidate
    return None


def _executable(command: list[str]) -> list[str]:
    """Resolve the agent runtime to an image Windows can start with this argv.

    CreateProcess searches PATH but only appends `.exe`, so a bare name misses
    an npm-installed CLI. Translate a validated standard npm shim to its Node
    entry point, fall through an unknown shim to a later native executable, and
    otherwise refuse rather than let cmd.exe mangle hook configuration.
    """
    if os.name != "nt":
        return command
    resolved = shutil.which(command[0])
    if resolved is None:
        return command
    if os.path.splitext(resolved)[1].lower() in {".cmd", ".bat"}:
        npm_command = _npm_shim_command(resolved, command[1:])
        if npm_command is not None:
            return npm_command
        native = _native_executable(command[0])
        if native is not None:
            return [native, *command[1:]]
        raise OSError(
            f"{command[0]} resolves to the script shim {resolved}, which cannot receive this "
            "command line unchanged. Install a native executable for it, or put one earlier on PATH."
        )
    return [resolved, *command[1:]]


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
        except FileNotFoundError:
            print(
                "This agent command can only be run once. Resume it from the Recent Activity section, "
                "or create a new agent from the Run Agent section.",
                file=sys.stderr,
            )
            return 2
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
    child = None
    try:
        try:
            child = subprocess.Popen(_executable(command))
        except OSError as error:
            # The command itself could not be run: the shell found the wrapper
            # but not the configured agent runtime. Nothing else will report this.
            spawn_error = str(error)
            exit_code = 127
            return exit_code
        write_marker(child.pid)
        execution_id = os.environ.get('HARNESS_EXECUTION_ID')
        if execution_id:
            from subagents_runtime.storage import connect
            from subagents_runtime.processes import birth_identity
            with connect() as connection:
                connection.execute('UPDATE executions SET supervisor_pid=?,supervisor_birth=?,provider_pid=?,provider_birth=? WHERE id=?', (os.getpid(),birth_identity(os.getpid()),child.pid,birth_identity(child.pid),execution_id))
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
        provider_alive = child is not None and child.poll() is None
        write_exit(exit_code, spawn_error)
        execution_id = os.environ.get('HARNESS_EXECUTION_ID')
        if execution_id:
            from subagents_runtime.storage import connect
            with connect() as connection:
                state = 'uncertain' if provider_alive else 'failed' if spawn_error else 'exited'
                connection.execute("UPDATE executions SET state=?,exit_code=?,exited_at=CASE WHEN ?='uncertain' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id=?", (state,exit_code,state,execution_id))
                session = connection.execute("SELECT session_id FROM executions WHERE id=?", (execution_id,)).fetchone()
            if session and not provider_alive:
                from subagents_runtime.delegation import report_child_stop
                report_child_stop(session[0], "", success=False,
                                  reason=spawn_error or "Provider process exited without delivering a result",
                                  cancelled=not spawn_error and os.environ.get("HARNESS_EXECUTION_MODE") == "interactive",
                                  execution_id=execution_id)
        if provider_alive:
            # A broken wrapper is no proof that its provider exited. Keep the marker.
            return 1
        try:
            os.remove(lock_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
