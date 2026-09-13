#!/usr/bin/env python3
"""Codex hook that waits through ChatGPT subscription usage-limit resets.

Usage is read through Codex's local app-server protocol so Codex remains
responsible for credential storage, token refresh, workspace selection, and
the private ChatGPT endpoint. The hook never reads or redeems reset tickets.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple


APP_SERVER_TIMEOUT = 20.0
GRACE_SECONDS = 120.0
MIN_SLEEP_SECONDS = 5.0
RELAXED_PERCENT = 90.0
ALERT_CACHE_TTL = 30.0
BLOCKED_CACHE_TTL = 15.0
NOTICE_TTL = 86400.0

DEFAULTS = {
    "THRESHOLD": "98",
    "WARN": "90",
    "NOTIFY_EVERY": "600",
    "MAX_WAIT": "604800",
    "POLL": "60",
    "CACHE_TTL": "300",
}

WINDOW_LABELS = {
    "session": "5-hour",
    "weekly_all": "weekly",
}


class Verdict(NamedTuple):
    blocked: bool
    reset_at: float | None
    kind: str | None


class Notice(NamedTuple):
    state: str
    kind: str | None
    percent: float
    reset_at: float | None


def _env(name: str, default: str = "") -> str:
    return os.environ.get("USAGE_LIMIT_WAIT_" + name, default).strip()


def _on(name: str) -> bool:
    return _env(name).lower() not in ("", "0", "false", "no", "off")


def _off(name: str) -> bool:
    return _env(name, "1").lower() in ("", "0", "false", "no", "off")


def _number(name: str) -> float:
    try:
        return float(_env(name, DEFAULTS[name]))
    except (TypeError, ValueError):
        return float(DEFAULTS[name])


def _ignored_kinds() -> set[str]:
    return {item.strip().lower() for item in _env("IGNORE").split(",") if item.strip()}


def codex_dir() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _write_json(path: Path, data: Any) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp.%d" % os.getpid())
        temporary.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass


# Codex app-server usage reader


def _app_server_messages() -> list[dict[str, Any]]:
    return [
        {
            "method": "initialize",
            "id": 1,
            "params": {"clientInfo": {"name": "usage-limit-wait", "version": "1.2.0"}},
        },
        {"method": "notifications/initialized"},
        {
            "method": "account/rateLimits/read",
            "id": 2,
            "params": {
                "supportsLunaReserve": False,
                "excludeResetCreditDetails": True,
            },
        },
    ]


def _send_message(process: subprocess.Popen[str], message: dict[str, Any]) -> None:
    if process.stdin is None:
        raise OSError("Codex app-server stdin is unavailable")
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _read_response(
    lines: "queue.Queue[str | None]", request_id: int, deadline: float
) -> dict[str, Any] | None:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return None
        if line is None:
            return None
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict) or message.get("id") != request_id:
            continue
        value = message.get("result")
        return value if isinstance(value, dict) else None


def fetch_usage() -> dict[str, Any] | None:
    """Read rate limits through Codex without handling its credentials here."""
    executable = shutil.which("codex")
    if not executable:
        return None
    child_env = dict(os.environ, USAGE_LIMIT_WAIT_DISABLE="1")
    process = None
    try:
        process = subprocess.Popen(
            [executable, "app-server", "--stdio"],
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=child_env,
        )
        lines: queue.Queue[str | None] = queue.Queue()

        def read_stdout() -> None:
            assert process is not None and process.stdout is not None
            try:
                for line in process.stdout:
                    lines.put(line)
            finally:
                lines.put(None)

        threading.Thread(target=read_stdout, daemon=True).start()
        messages = _app_server_messages()
        deadline = time.monotonic() + APP_SERVER_TIMEOUT
        _send_message(process, messages[0])
        if _read_response(lines, 1, deadline) is None:
            return None
        _send_message(process, messages[1])
        _send_message(process, messages[2])
        return _read_response(lines, 2, deadline)
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        if process is not None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
                process.terminate()
                process.wait(timeout=2)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except OSError:
                    pass


def _percent(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if 0 <= number <= 100 else None


def _epoch(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def snapshot_from_app_server(payload: dict[str, Any]) -> dict[str, Any] | None:
    limits = payload.get("rateLimits")
    if not isinstance(limits, dict):
        return None
    windows = []
    for field, kind in (("primary", "session"), ("secondary", "weekly_all")):
        raw = limits.get(field)
        if not isinstance(raw, dict):
            continue
        percent = _percent(raw.get("usedPercent"))
        if percent is None:
            continue
        windows.append({
            "kind": kind,
            "percent": percent,
            "resets_at": _epoch(raw.get("resetsAt")),
        })
    if not windows:
        return None

    raw_credits = limits.get("credits")
    credits = None
    if isinstance(raw_credits, dict):
        unlimited = raw_credits.get("unlimited") is True
        has_credits = raw_credits.get("hasCredits") is True
        try:
            positive_balance = float(raw_credits.get("balance") or 0) > 0
        except (TypeError, ValueError):
            positive_balance = False
        credits = {
            "enabled": unlimited or has_credits or positive_balance,
            "exhausted": not (unlimited or positive_balance),
        }
    return {"source": "codex-app-server", "windows": windows, "credits": credits}


# cache and decisions


def cache_path() -> Path:
    return codex_dir() / ".usage-limit-wait.cache.json"


def cache_ttl(snapshot: dict[str, Any] | None) -> float:
    if snapshot is None:
        return _number("CACHE_TTL")
    percentages = [
        window.get("percent") for window in snapshot.get("windows", [])
        if isinstance(window.get("percent"), (int, float))
    ]
    peak = max(percentages, default=0.0)
    if peak >= _number("THRESHOLD"):
        return BLOCKED_CACHE_TTL
    if peak >= RELAXED_PERCENT:
        return ALERT_CACHE_TTL
    return _number("CACHE_TTL")


def _looks_like_snapshot(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict) or not isinstance(value.get("windows"), list):
        return False
    return all(
        isinstance(window, dict)
        and isinstance(window.get("kind"), str)
        and isinstance(window.get("percent"), (int, float))
        for window in value["windows"]
    )


def read_cache(now: float) -> dict[str, Any] | None:
    entry = _read_json(cache_path())
    if not entry or not isinstance(entry.get("fetched_at"), (int, float)):
        return None
    snapshot = entry.get("snapshot")
    if not _looks_like_snapshot(snapshot):
        return None
    age = now - entry["fetched_at"]
    if age < 0 or age > cache_ttl(snapshot):
        return None
    return entry


def write_cache(snapshot: dict[str, Any] | None, now: float) -> None:
    _write_json(cache_path(), {"fetched_at": now, "snapshot": snapshot})


def read_usage(force: bool = False, now: float | None = None) -> dict[str, Any] | None:
    now = time.time() if now is None else now
    if not force:
        cached = read_cache(now)
        if cached is not None:
            return cached.get("snapshot")
    payload = fetch_usage()
    snapshot = snapshot_from_app_server(payload) if payload is not None else None
    write_cache(snapshot, now)
    return snapshot


def evaluate(snapshot: dict[str, Any] | None) -> Verdict:
    if snapshot is None:
        return Verdict(False, None, None)
    if _on("USE_CREDITS"):
        credits = snapshot.get("credits")
        if isinstance(credits, dict) and credits.get("enabled") and not credits.get("exhausted"):
            return Verdict(False, None, None)

    ignored = _ignored_kinds()
    blocked = [
        window for window in snapshot["windows"]
        if window["percent"] >= _number("THRESHOLD")
        and str(window.get("kind", "")).lower() not in ignored
    ]
    if not blocked:
        return Verdict(False, None, None)
    datable = [window for window in blocked if isinstance(window.get("resets_at"), (int, float))]
    if not datable:
        return Verdict(True, None, blocked[0].get("kind"))
    soonest = min(datable, key=lambda window: window["resets_at"])
    return Verdict(True, soonest["resets_at"], soonest.get("kind"))


def wait_for_reset(
    snapshot: dict[str, Any] | None,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
    refresh: Callable[[], dict[str, Any] | None] | None = None,
) -> tuple[float, str | None]:
    refresh = refresh or (lambda: read_usage(force=True, now=now()))
    started = now()
    deadline = started + _number("MAX_WAIT")
    verdict = evaluate(snapshot)
    waited_for = verdict.kind
    while verdict.blocked:
        if verdict.reset_at is None or verdict.reset_at > deadline:
            break
        remaining = deadline - now()
        if remaining <= 0:
            break
        until_reset = max(verdict.reset_at + GRACE_SECONDS - now(), MIN_SLEEP_SECONDS)
        sleep(min(until_reset, max(_number("POLL"), MIN_SLEEP_SECONDS), remaining))
        refreshed = refresh()
        if refreshed is None:
            if now() < verdict.reset_at + GRACE_SECONDS:
                continue
            break
        snapshot = refreshed
        verdict = evaluate(refreshed)
        if verdict.blocked and verdict.kind:
            waited_for = verdict.kind
    return now() - started, waited_for


# notices and cross-process wait serialization


def assess(snapshot: dict[str, Any] | None, now: float) -> Notice | None:
    if snapshot is None:
        return None
    ignored = _ignored_kinds()
    windows = [
        window for window in snapshot["windows"]
        if str(window.get("kind", "")).lower() not in ignored
    ]
    if not windows:
        return None
    peak = max(windows, key=lambda window: window["percent"])
    if peak["percent"] < _number("THRESHOLD"):
        if peak["percent"] < _number("WARN"):
            return None
        return Notice("warn", peak.get("kind"), peak["percent"], peak.get("resets_at"))
    verdict = evaluate(snapshot)
    window = next((item for item in windows if item.get("kind") == verdict.kind), peak)
    if not verdict.blocked:
        return Notice("credits", window.get("kind"), window["percent"], window.get("resets_at"))
    if verdict.reset_at is None:
        return Notice("no-reset", verdict.kind, window["percent"], None)
    if verdict.reset_at - now > _number("MAX_WAIT"):
        return Notice("too-far", verdict.kind, window["percent"], verdict.reset_at)
    return Notice("waiting", verdict.kind, window["percent"], verdict.reset_at)


def _clock(epoch: float) -> str:
    return time.strftime("%H:%M", time.localtime(epoch))


def format_duration(seconds: float | int) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return "%dh%02dm" % (hours, minutes)
    if minutes:
        return "%dm%02ds" % (minutes, seconds)
    return "%ds" % seconds


def notice_text(notice: Notice, now: float) -> str:
    label = WINDOW_LABELS.get(notice.kind, notice.kind) if notice.kind else "usage"
    window = "%s window is %d%% used" % (label, round(notice.percent))
    if notice.state == "warn":
        if notice.reset_at is None:
            return "Codex usage: the %s. The session will pause here by itself if it runs out." % window
        return (
            "Codex usage: the %s and resets at %s, in %s. The session will pause "
            "here by itself if it runs out."
            % (window, _clock(notice.reset_at), format_duration(notice.reset_at - now))
        )
    if notice.state == "waiting":
        return (
            "Codex usage limit reached: the %s. Pausing until %s, about %s, then "
            "carrying on by itself. Esc interrupts the wait."
            % (window, _clock(notice.reset_at or now), format_duration((notice.reset_at or now) - now))
        )
    if notice.state == "credits":
        return (
            "Codex usage limit reached: the %s. Not pausing -- USAGE_LIMIT_WAIT_USE_CREDITS "
            "is set, so this session keeps going on usage credits." % window
        )
    if notice.state == "too-far":
        return (
            "Codex usage limit reached: the %s and does not reset for %s, which is longer "
            "than USAGE_LIMIT_WAIT_MAX_WAIT. Not pausing."
            % (window, format_duration((notice.reset_at or now) - now))
        )
    return (
        "Codex usage limit reached: the %s, and no reset time came back with it. "
        "Not pausing." % window
    )


def notices_path() -> Path:
    return codex_dir() / ".usage-limit-wait.notices.json"


def announce_once(key: str, session_id: str, now: float, interval: float) -> bool:
    stored = _read_json(notices_path()) or {}
    sessions = stored.get("sessions")
    sessions = sessions if isinstance(sessions, dict) else {}
    sessions = {
        name: seen for name, seen in sessions.items()
        if isinstance(seen, dict)
        and any(isinstance(when, (int, float)) and now - when < NOTICE_TTL for when in seen.values())
    }
    seen = sessions.setdefault(session_id, {})
    last = seen.get(key)
    if isinstance(last, (int, float)) and 0 <= now - last < interval:
        return False
    seen[key] = now
    _write_json(notices_path(), {"sessions": sessions})
    return True


@contextmanager
def exclusive_wait_lock() -> Iterator[None]:
    """Serialize parallel PostToolUse waiters; OS locks disappear on exit."""
    path = codex_dir() / ".usage-limit-wait.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            deadline = time.monotonic() + _number("MAX_WAIT")
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise
                    time.sleep(min(1.0, remaining))
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def desktop_notification(title: str, body: str) -> bool:
    if _off("OS_NOTIFICATION"):
        return False
    command = None
    child_env = None
    if sys.platform == "darwin":
        executable = shutil.which("osascript")
        if executable:
            command = [executable, "-e", "on run argv", "-e",
                       "display notification (item 2 of argv) with title (item 1 of argv)",
                       "-e", "end run", title, body]
    elif sys.platform == "win32":
        executable = shutil.which("powershell.exe") or shutil.which("powershell")
        if executable:
            script = (
                "$ErrorActionPreference='Stop';"
                "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,"
                "ContentType=WindowsRuntime]>$null;"
                "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,"
                "ContentType=WindowsRuntime]>$null;"
                "$title=[Security.SecurityElement]::Escape($env:USAGE_LIMIT_WAIT_NOTIFICATION_TITLE);"
                "$body=[Security.SecurityElement]::Escape($env:USAGE_LIMIT_WAIT_NOTIFICATION_BODY);"
                "$xml=New-Object Windows.Data.Xml.Dom.XmlDocument;"
                "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'>\"+"
                "\"<text>$title</text><text>$body</text></binding></visual></toast>\");"
                "$toast=New-Object Windows.UI.Notifications.ToastNotification $xml;"
                "$appId=(Get-StartApps|Where-Object {$_.AppID -like "
                "'*\\WindowsPowerShell\\v1.0\\powershell.exe'}|"
                "Select-Object -First 1 -ExpandProperty AppID);"
                "if(-not $appId){$appId='Microsoft.PowerShell'};"
                "[Windows.UI.Notifications.ToastNotificationManager]::"
                "CreateToastNotifier($appId).Show($toast)"
            )
            command = [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
            child_env = dict(
                os.environ,
                USAGE_LIMIT_WAIT_NOTIFICATION_TITLE=title,
                USAGE_LIMIT_WAIT_NOTIFICATION_BODY=body,
            )
    else:
        executable = shutil.which("notify-send")
        if executable:
            command = [executable, "--app-name=Codex", title, body]
    if command is None:
        return False
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=10, env=child_env,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


# hook entry point


def run(session_id: str = "", now: float | None = None) -> dict[str, str] | None:
    now = time.time() if now is None else now
    snapshot = read_usage(now=now)
    notice = assess(snapshot, now)
    if notice is None:
        return None
    if notice.state != "waiting":
        key = "%s:%s" % (notice.state, notice.kind or "")
        if not announce_once(key, session_id, now, _number("NOTIFY_EVERY")):
            return None
        return {"systemMessage": notice_text(notice, now)}

    with exclusive_wait_lock():
        snapshot = read_usage(force=True)
        current = time.time()
        notice = assess(snapshot, current)
        if notice is None or notice.state != "waiting":
            return None
        desktop_notification("Codex paused", notice_text(notice, current))
        waited, kind = wait_for_reset(snapshot)
    if waited < 1:
        return None
    label = WINDOW_LABELS.get(kind, kind) if kind else "usage"
    duration = format_duration(waited)
    desktop_notification("Codex resumed", "Waited %s for the %s limit to reset" % (duration, label))
    return {"systemMessage": "usage-limit-wait: waited %s for the %s limit to reset." % (duration, label)}


def hook_input() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def main(argv: list[str] | None = None) -> int:
    event = hook_input()
    try:
        if _on("DISABLE"):
            return 0
        payload = run(str(event.get("session_id") or ""))
    except Exception:
        return 0
    if payload:
        print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
