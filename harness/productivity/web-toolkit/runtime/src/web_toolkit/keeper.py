"""Shared-browser keeper: runs Chrome until it has been idle for ``IDLE_SECONDS``.

Standard library only.  The keeper outlives the commands that start it and runs
under the base interpreter rather than the tool's environment: on Windows, a
running interpreter from that environment would lock it against upgrades.

Usage: python -I keeper.py <state-dir> <json-encoded Chrome argv>
"""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

IDLE_SECONDS = 600
START_TIMEOUT = 20
POLL_SECONDS = 5


@contextmanager
def lock(path: Path, timeout: float) -> Iterator[None]:
    """Exclusive inter-process lock on ``path``, shared with the CLI."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+b") as handle:
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"timed out waiting for {path}") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def endpoint(state: Path) -> str | None:
    """The live browser's DevTools WebSocket URL, or None when nothing answers."""
    try:
        port = (state / "profile" / "DevToolsActivePort").read_text(encoding="utf-8").split()[0]
        with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}/json/version", timeout=1) as response:
            return json.load(response)["webSocketDebuggerUrl"]
    except (OSError, ValueError, IndexError, KeyError):
        return None


def _idle(state: Path) -> bool:
    try:
        return time.time() - (state / "last-used").stat().st_mtime > IDLE_SECONDS
    except OSError:
        return True


def _close(url: str) -> None:
    """Send one ``Browser.close`` command over a minimal WebSocket handshake."""
    parts = urlsplit(url)
    try:
        with socket.create_connection((parts.hostname, parts.port), timeout=5) as connection:
            key = base64.b64encode(os.urandom(16)).decode()
            connection.sendall(
                f"GET {parts.path} HTTP/1.1\r\nHost: {parts.netloc}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
            )
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = connection.recv(4096)
                if not chunk:
                    return
                response += chunk
            if b" 101 " not in response.split(b"\r\n", 1)[0]:
                return
            payload = json.dumps({"id": 1, "method": "Browser.close"}).encode()
            mask = os.urandom(4)
            frame = bytes([0x81, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            connection.sendall(frame)
            connection.recv(4096)
    except OSError:
        pass


def serve(state: Path, chrome: list[str]) -> None:
    # The launched executable may hand off to a separate browser process and exit,
    # as Chrome does on Windows, so the keeper follows the DevTools endpoint instead.
    subprocess.Popen(chrome, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + START_TIMEOUT
    while endpoint(state) is None:
        if time.monotonic() > deadline:
            return
        time.sleep(0.1)
    while endpoint(state) is not None:
        time.sleep(POLL_SECONDS)
        if not _idle(state):
            continue
        with lock(state / "browser.lock", START_TIMEOUT * 2):
            if _idle(state) and (url := endpoint(state)):
                _close(url)
                deadline = time.monotonic() + 10
                while endpoint(state) is not None and time.monotonic() < deadline:
                    time.sleep(0.2)


if __name__ == "__main__":
    serve(Path(sys.argv[1]), json.loads(sys.argv[2]))
