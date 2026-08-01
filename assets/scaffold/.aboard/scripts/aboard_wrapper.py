"""aboard's launch wrapper: owns a lock-marker file for exactly the child's lifetime.

Usage:
    python aboard_wrapper.py <lock-file> -- <command> [args...]

The extension launches every Claude session through this wrapper. The wrapper
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
"""

import json
import os
import subprocess
import sys
import time


def main():
    args = sys.argv[1:]
    if len(args) < 3 or args[1] != "--":
        return 2
    lock_path = args[0]
    command = args[2:]

    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    started_at = time.strftime("%Y-%m-%dT%H:%M:%S")

    # The marker exists before the child: a poll racing the spawn must find the
    # session already alive.
    def write_marker(child_pid):
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

    write_marker(None)
    try:
        child = subprocess.Popen(command)
        write_marker(child.pid)
        while True:
            try:
                return child.wait()
            except KeyboardInterrupt:
                # Ctrl+C reached the wrapper too; the child decides whether to
                # exit. Keep owning the marker until it does.
                if child.poll() is not None:
                    return child.returncode
    finally:
        try:
            os.remove(lock_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
