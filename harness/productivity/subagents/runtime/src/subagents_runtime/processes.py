"""Detached execution supervision and PID birth identity checks."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from subagents_runtime.storage import connect, state_dir


def birth_identity(pid: int) -> str | None:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetProcessTimes.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
        ]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        creation, exit_time, kernel_time, user_time = (
            wintypes.FILETIME() for _ in range(4)
        )
        try:
            if not kernel.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            ):
                return None
            return str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
    if sys.platform.startswith("linux"):
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
            fields = raw[raw.rindex(")") + 2 :].split()
            if fields[0] == "Z":
                return None
            return fields[19]
        except (OSError, IndexError):
            return None
    try:
        value = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "lstart="], text=True
        ).strip()
        return value or None
    except subprocess.CalledProcessError:
        return None


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetExitCodeProcess.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return (
                not kernel.GetExitCodeProcess(handle, ctypes.byref(code))
                or code.value == 259
            )
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def live_executions(session_id: str) -> list[str]:
    """Settle every verifiably dead execution and report the ones still running."""
    with connect() as connection:
        rows = connection.execute(
            "SELECT id,supervisor_pid,supervisor_birth,provider_pid,provider_birth FROM executions WHERE session_id=? AND superseded_at IS NULL AND state IN ('prepared','starting','running','uncertain')",
            (session_id,),
        ).fetchall()
    live = []
    for (
        execution_id,
        supervisor,
        supervisor_birth,
        provider,
        provider_birth,
    ) in rows:
        identities = [
            (pid, birth)
            for pid, birth in (
                (supervisor, supervisor_birth),
                (provider, provider_birth),
            )
            if pid
        ]
        if not identities or any(
            (birth is not None and birth_identity(pid) == birth)
            or ((birth is None or birth_identity(pid) is None) and process_alive(pid))
            for pid, birth in identities
        ):
            live.append(execution_id)
            continue
        with connect() as connection:
            connection.execute(
                "UPDATE executions SET state='exited',exited_at=CURRENT_TIMESTAMP WHERE id=?",
                (execution_id,),
            )
        from subagents_runtime.delegation import report_child_stop

        report_child_stop(
            session_id,
            "",
            success=False,
            reason="execution ended before delivering a result",
            cancelled=True,
            execution_id=execution_id,
        )
    return live


def require_exited(session_id: str) -> None:
    from subagents_runtime.sessions import SessionError

    if live_executions(session_id):
        raise SessionError(
            f"{session_id} still has a running or uncertain execution; resume refused"
        )


def confirm_startup(execution_id: str, provider_pid: int | None = None) -> None:
    with connect() as connection:
        connection.execute(
            "UPDATE executions SET state='running',started_at=CURRENT_TIMESTAMP,provider_pid=COALESCE(?,provider_pid),provider_birth=COALESCE(?,provider_birth) WHERE id=? AND state IN ('prepared','starting','uncertain')",
            (
                provider_pid,
                birth_identity(provider_pid) if provider_pid else None,
                execution_id,
            ),
        )
        connection.execute(
            "UPDATE requests SET state='pending' WHERE id=(SELECT request_id FROM executions WHERE id=?) AND state IN ('launching','uncertain')",
            (execution_id,),
        )
        row = connection.execute(
            "SELECT r.parent_session_id,r.source_name FROM requests r JOIN executions e ON e.request_id=r.id WHERE e.id=?",
            (execution_id,),
        ).fetchone()
        if row and row[1]:
            inbox = connection.execute(
                "SELECT inbox FROM session_delegation WHERE parent_session_id=?",
                (row[0],),
            ).fetchone()
            if inbox:
                (Path(inbox[0]) / (row[1] + ".running")).unlink(missing_ok=True)
                connection.execute(
                    "UPDATE requests SET source_deleted_at=CURRENT_TIMESTAMP WHERE id=(SELECT request_id FROM executions WHERE id=?)",
                    (execution_id,),
                )


def start(
    execution_id: str,
    argv: list[str],
    environment: dict[str, str],
    cwd: Path,
    *,
    visible: bool,
) -> None:
    from subagents_runtime import sessions

    with connect() as connection:
        row = connection.execute(
            "SELECT COALESCE(s.parent_session_id,s.id) FROM executions e JOIN sessions s ON s.id=e.session_id WHERE e.id=?",
            (execution_id,),
        ).fetchone()
        changed = connection.execute(
            "UPDATE executions SET state='starting' WHERE id=? AND state='prepared'",
            (execution_id,),
        )
        if changed.rowcount != 1:
            raise sessions.SessionError("Execution was already started or is uncertain")
    root = state_dir() / "runtime" / "sessions" / row[0] / "executions" / execution_id
    specification = root / "launch.json"
    try:
        root.mkdir(parents=True, exist_ok=True)
        specification.write_text(
            json.dumps(
                {
                    "argv": argv,
                    "environment": environment,
                    "cwd": str(cwd),
                    "visible": visible,
                }
            ),
            encoding="utf-8",
        )
        specification.chmod(0o600)
        command = [
            sys.executable,
            "-m",
            "subagents_runtime.processes",
            execution_id,
            str(specification),
        ]
        if visible:
            sessions._visible_terminal(command, environment, cwd)
        else:
            options = (
                {
                    "creationflags": subprocess.CREATE_NO_WINDOW
                    | subprocess.DETACHED_PROCESS
                }
                if os.name == "nt"
                else {"start_new_session": True}
            )
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                **options,
            )
            with connect() as connection:
                connection.execute(
                    "UPDATE executions SET supervisor_pid=?,supervisor_birth=? WHERE id=?",
                    (process.pid, birth_identity(process.pid), execution_id),
                )
    except (OSError, sessions.SessionError):
        with connect() as connection:
            connection.execute(
                "UPDATE executions SET state='failed',exited_at=CURRENT_TIMESTAMP WHERE id=?",
                (execution_id,),
            )
        specification.unlink(missing_ok=True)
        raise
    # Startup is proven by SessionStart or structured provider output, never Popen.
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with connect() as connection:
            state = connection.execute(
                "SELECT state FROM executions WHERE id=?", (execution_id,)
            ).fetchone()[0]
        if state in {"running", "exited"}:
            return
        if state == "failed":
            raise sessions.SessionError("Provider startup failed")
        time.sleep(0.05)
    raise sessions.SessionError("Provider startup could not be verified")


def native_command(argv: list[str]) -> list[str]:
    """Resolve Windows npm shims to native Node argv without shell interpolation."""
    if os.name != "nt":
        return argv
    executable = shutil.which(argv[0]) or argv[0]
    if Path(executable).suffix.lower() not in {".cmd", ".bat"}:
        return [executable, *argv[1:]]
    contents = Path(executable).read_text(encoding="utf-8")
    match = re.search(
        r'&\s+"%_prog%"\s+"%dp0%\\([^"\r\n]+\.js)"\s+%\*\s*$',
        contents,
        re.IGNORECASE | re.MULTILINE,
    )
    if not match:
        raise OSError(
            "Provider command resolves to an unsupported script shim; configure native executable argv"
        )
    root = Path(executable).resolve().parent
    entry = (root / match[1].replace("\\", "/")).resolve()
    if not entry.is_relative_to(root) or not entry.is_file():
        raise OSError("Provider npm entry point is invalid")
    node = root / "node.exe"
    selected = str(node) if node.is_file() else shutil.which("node.exe")
    if not selected:
        raise OSError("Node executable is unavailable for provider npm shim")
    return [selected, str(entry), *argv[1:]]


def supervise(execution_id: str, specification: Path) -> int:
    value = json.loads(specification.read_text(encoding="utf-8"))
    specification.unlink(missing_ok=True)
    environment = value["environment"]
    environment["HARNESS_EXECUTION_ID"] = execution_id
    root = specification.parent
    with connect() as connection:
        connection.execute(
            "UPDATE executions SET supervisor_pid=?,supervisor_birth=? WHERE id=?",
            (os.getpid(), birth_identity(os.getpid()), execution_id),
        )
    process = None
    try:
        with (root / "stderr.log").open("wb") as errors:
            options = (
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt" and not value["visible"]
                else {}
            )
            process = subprocess.Popen(
                native_command(value["argv"]),
                cwd=value["cwd"],
                env=environment,
                stdin=None if value["visible"] else subprocess.DEVNULL,
                stdout=None if value["visible"] else subprocess.PIPE,
                stderr=None if value["visible"] else errors,
                **options,
            )
            with connect() as connection:
                connection.execute(
                    "UPDATE executions SET provider_pid=?,provider_birth=? WHERE id=?",
                    (process.pid, birth_identity(process.pid), execution_id),
                )
            message = ""
            if process.stdout:
                with (root / "stdout.jsonl").open("wb") as output:
                    for line in process.stdout:
                        output.write(line)
                        output.flush()
                        try:
                            event = json.loads(line)
                        except (ValueError, UnicodeError):
                            continue
                        conversation = event.get("thread_id") or event.get("session_id")
                        if conversation:
                            with connect() as connection:
                                connection.execute(
                                    "UPDATE sessions SET provider_session_id=? WHERE id=?",
                                    (conversation, environment["HARNESS_SESSION_ID"]),
                                )
                            confirm_startup(execution_id, process.pid)
                        if event.get("type") == "result":
                            message = event.get("result", "")
                        item = event.get("item", {})
                        if (
                            isinstance(item, dict)
                            and item.get("type") == "agent_message"
                        ):
                            message = item.get("text", "")
            code = process.wait()
        with connect() as connection:
            state = connection.execute(
                "SELECT state FROM executions WHERE id=?", (execution_id,)
            ).fetchone()[0]
            started = state == "running"
            connection.execute(
                "UPDATE executions SET state=?,exit_code=?,exited_at=CURRENT_TIMESTAMP WHERE id=?",
                ("exited" if started else "failed", code, execution_id),
            )
        from subagents_runtime.delegation import report_child_stop

        if value["visible"]:
            report_child_stop(
                environment["HARNESS_SESSION_ID"],
                "",
                success=False,
                reason="Provider process exited",
                cancelled=True,
                execution_id=execution_id,
            )
        else:
            report_child_stop(
                environment["HARNESS_SESSION_ID"],
                message,
                success=code == 0 and bool(message),
                reason=None if code == 0 else f"Provider exit {code}",
                execution_id=execution_id,
            )
        return code
    except Exception as exc:  # noqa: BLE001 - Record any supervisor failure before exiting.
        uncertain = process is not None and process.poll() is None
        state = "uncertain" if uncertain else "failed"
        with connect() as connection:
            connection.execute(
                "UPDATE executions SET state=?,exited_at=CASE WHEN ?='failed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?",
                (state, state, execution_id),
            )
            connection.execute(
                "UPDATE requests SET state=?,reason=?,delivery_id=CASE WHEN ?='failed' THEN COALESCE(delivery_id,lower(hex(randomblob(16)))) ELSE delivery_id END,completed_at=CASE WHEN ?='failed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=(SELECT request_id FROM executions WHERE id=?) AND state IN ('launching','pending','uncertain')",
                (state, str(exc), state, state, execution_id),
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(supervise(sys.argv[1], Path(sys.argv[2])))
