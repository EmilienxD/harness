"""One shared headless Chrome per machine, started on demand and closed when idle.

The first command that needs a browser starts a detached keeper process (see
``keeper``), which launches Chrome with a dedicated profile and an ephemeral
DevTools port and closes it once idle.  Every command attaches over the Chrome
DevTools Protocol, works in its own tab, and closes that tab.

Automation stays minimal on purpose: no automation flags, no ``Runtime.enable``,
and a user agent without the "HeadlessChrome" token.  Search engines block
browsers that show any of these signals.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from websockets.exceptions import ConnectionClosed, InvalidHandshake
from websockets.sync.client import ClientConnection, connect

from web_toolkit import keeper

START_TIMEOUT = keeper.START_TIMEOUT


class BrowserError(Exception):
    pass


class BrowserClosed(BrowserError):
    """The browser went away mid-operation; nothing in the tab can be retried."""


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".harness"
    return root / "web-toolkit"


def _profile() -> Path:
    return state_dir() / "profile"


def _touch() -> None:
    marker = state_dir() / "last-used"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()


def find_executable() -> str:
    configured = os.environ.get("WEB_TOOLKIT_BROWSER")
    if configured:
        if Path(configured).is_file():
            return configured
        raise BrowserError(f"WEB_TOOLKIT_BROWSER does not point to a file: {configured}")
    if os.name == "nt":
        roots = [os.environ.get(name) for name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        candidates = [
            Path(root) / relative
            for root in roots if root
            for relative in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe")
        ]
    elif sys.platform == "darwin":
        candidates = [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
    else:
        names = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge")
        candidates = [Path(found) for name in names if (found := shutil.which(name))]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise BrowserError("no Chrome, Edge, or Chromium installation found; install Google Chrome or set WEB_TOOLKIT_BROWSER")


def _major_version(executable: str) -> int | None:
    path = Path(executable)
    # Windows installs keep the full version as a directory beside the executable.
    versions = [entry.name for entry in path.parent.iterdir() if re.fullmatch(r"\d+(\.\d+){3}", entry.name)]
    if not versions and os.name != "nt":
        try:
            output = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired):
            output = ""
        versions = re.findall(r"\d+(?:\.\d+){3}", output)
    return max(int(version.split(".")[0]) for version in versions) if versions else None


def _user_agent(executable: str) -> str | None:
    major = _major_version(executable)
    if major is None:
        return None
    system = (
        "Windows NT 10.0; Win64; x64" if os.name == "nt"
        else "Macintosh; Intel Mac OS X 10_15_7" if sys.platform == "darwin"
        else "X11; Linux x86_64"
    )
    return f"Mozilla/5.0 ({system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"


def _chrome_arguments(executable: str) -> list[str]:
    arguments = [
        executable,
        "--headless=new",
        # Chrome's process sandbox cannot start inside agent sandboxes such as Codex's.
        "--no-sandbox",
        "--remote-debugging-port=0",
        f"--user-data-dir={_profile()}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--window-size=1920,1080",
        "--lang=en-US",
        "--mute-audio",
    ]
    if user_agent := _user_agent(executable):
        arguments.append(f"--user-agent={user_agent}")
    return arguments


def _spawn_keeper(executable: str) -> None:
    # The base interpreter keeps the tool's environment unlocked while Chrome runs.
    interpreter = getattr(sys, "_base_executable", None) or sys.executable
    command = [interpreter, "-I", keeper.__file__, str(state_dir()), json.dumps(_chrome_arguments(executable))]
    options: dict[str, Any] = {
        "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
        "close_fds": True, "cwd": state_dir(),
    }
    if os.name != "nt":
        subprocess.Popen(command, start_new_session=True, **options)
        return
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        # Outlive agent sandboxes that terminate a command's whole job on exit.
        subprocess.Popen(command, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **options)
    except OSError:
        subprocess.Popen(command, creationflags=flags, **options)


def ensure() -> str:
    """Return the shared browser's WebSocket URL, starting the browser if needed."""
    _touch()
    state = state_dir()
    if endpoint := keeper.endpoint(state):
        return endpoint
    try:
        with keeper.lock(state / "browser.lock", START_TIMEOUT * 2):
            if endpoint := keeper.endpoint(state):
                return endpoint
            executable = find_executable()
            (_profile() / "DevToolsActivePort").unlink(missing_ok=True)
            _spawn_keeper(executable)
            deadline = time.monotonic() + START_TIMEOUT
            while time.monotonic() < deadline:
                if endpoint := keeper.endpoint(state):
                    return endpoint
                time.sleep(0.1)
    except TimeoutError as exc:
        raise BrowserError(str(exc)) from exc
    raise BrowserError(f"the browser did not start within {START_TIMEOUT} seconds")


class Cdp:
    """Request/response calls over one DevTools connection; events are ignored."""

    def __init__(self, websocket: ClientConnection):
        self._websocket = websocket
        self._ids = itertools.count(1)

    def call(self, method: str, session: str | None = None, timeout: float = 30, **params: Any) -> dict[str, Any]:
        identifier = next(self._ids)
        message: dict[str, Any] = {"id": identifier, "method": method, "params": params}
        if session:
            message["sessionId"] = session
        try:
            self._websocket.send(json.dumps(message))
            reply = self._reply(identifier, time.monotonic() + timeout)
        except ConnectionClosed as exc:
            raise BrowserClosed("the browser closed the connection") from exc
        except TimeoutError as exc:
            raise BrowserError(f"{method} timed out") from exc
        if "error" in reply:
            raise BrowserError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result", {})

    def _reply(self, identifier: int, deadline: float) -> dict[str, Any]:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            reply = json.loads(self._websocket.recv(timeout=remaining))
            if reply.get("id") == identifier:
                return reply


class Tab:
    def __init__(self, cdp: Cdp, session: str):
        self._cdp = cdp
        self._session = session

    def navigate(self, url: str) -> str | None:
        """Start loading ``url``; return Chrome's error text when it cannot."""
        return self._cdp.call("Page.navigate", self._session, url=url).get("errorText") or None

    def evaluate(self, expression: str) -> Any:
        """Evaluate JavaScript and return its JSON value; None while the page is replaced."""
        try:
            result = self._cdp.call("Runtime.evaluate", self._session, expression=expression, returnByValue=True)
        except BrowserClosed:
            raise
        except BrowserError:
            return None
        if "exceptionDetails" in result:
            return None
        return result.get("result", {}).get("value")


@contextmanager
def tab() -> Iterator[Tab]:
    """Open a background tab in the shared browser and close it afterwards."""
    try:
        connection = connect(ensure(), max_size=None, open_timeout=10, close_timeout=0.2)
    except (OSError, InvalidHandshake) as exc:
        raise BrowserError(f"cannot connect to the browser: {exc}") from exc
    with connection as websocket:
        cdp = Cdp(websocket)
        target = cdp.call("Target.createTarget", url="about:blank", background=True)["targetId"]
        try:
            session = cdp.call("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
            yield Tab(cdp, session)
        finally:
            try:
                cdp.call("Target.closeTarget", targetId=target, timeout=5)
            except Exception:
                pass
            _touch()
