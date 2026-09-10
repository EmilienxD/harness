#!/usr/bin/env python3
"""
Claude Code hook that sleeps through a subscription usage-limit reset.

Registered on two events -- `UserPromptSubmit` (before the turn's first model
request) and `PostToolBatch` (once per batch, immediately before the next
model request). Both are the last moment before Claude Code talks to the API,
which is the only useful place to stall.

Claude Code does not render a hook's output until every hook on the event has
finished. The process therefore sends a platform-native desktop notification
itself immediately before sleeping; returning `systemMessage` or
`terminalSequence` there would leave the announcement buffered until the wait
was already over.

The waiter blocks -- literally `time.sleep` -- until the window resets,
re-polling along the way so an early reset, a cancelled subscription, or a ban
ends the wait promptly. The session then continues on its own instead of dying
with "limit reached".

Everything fails open. The hook is only meaningful for a Claude subscription,
so any sign of another credential path (API key, bearer gateway, Bedrock,
Vertex, Foundry), a missing OAuth token, or an initially unreadable usage
response means exit 0 immediately and let Claude Code handle its own errors.
Once a confirmed wait has begun, a transient read failure is not mistaken for
a reset: the last announced reset remains authoritative until it arrives. It
never blocks a tool call, never writes to the model's context, and never waits
longer than `USAGE_LIMIT_WAIT_MAX_WAIT` (7 days: a reset further out than that
means there is no subscription behind this session).

Configuration is environment-only; see the README for the full table.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, NamedTuple
from urllib import error as urlerror
from urllib import request as urlrequest

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

# Verified against a live subscription session. `anthropic-beta` is what makes
# the endpoint accept an OAuth bearer token instead of an API key.
USAGE_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": "claude-cli/2.1.233 (external, cli)",
    "anthropic-beta": "oauth-2025-04-20",
}

# Environment variables that each mean "this session is not billed to a Claude
# subscription". A subscription session sets none of them.
API_KEY_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
PROVIDER_ENV = ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")

FALSEY = ("", "0", "false", "no", "off")

# Wait two minutes after the announced reset before resuming. This gives the
# usage service time to apply the reset, avoiding a request that lands at the
# wall and wastes a whole poll cycle.
GRACE_SECONDS = 120.0

# Never re-poll faster than this, even when the announced reset is already in
# the past (which happens, and would otherwise spin on the network).
MIN_SLEEP_SECONDS = 5.0

# The CLI fallback spawns a whole `claude` process, so it polls far less often.
CLI_MIN_POLL_SECONDS = 300.0

# Below this, usage is nowhere near the wall and the cached reading can be old.
RELAXED_PERCENT = 90.0
ALERT_CACHE_TTL = 30.0

# An exhausted reading stays briefly reusable so simultaneous Claude Code
# sessions do not all hit the usage endpoint at once.
BLOCKED_CACHE_TTL = 15.0

# A notice older than this is forgotten, so the throttle file cannot grow
# without bound as sessions come and go.
NOTICE_TTL = 86400.0

DEFAULTS = {
    "THRESHOLD": 98.0,
    "WARN": RELAXED_PERCENT,
    "MAX_WAIT": 604800.0,  # 7 days
    "POLL": 60.0,
    "CACHE_TTL": 300.0,
    "NOTIFY_EVERY": 600.0,
}

# `kind` values as the API spells them, mapped to what a human calls the window.
WINDOW_LABELS = {
    "session": "5-hour",
    "weekly_all": "weekly",
    "weekly_opus": "weekly Opus",
    "weekly_sonnet": "weekly Sonnet",
}


class Verdict(NamedTuple):
    blocked: bool
    reset_at: float | None
    kind: str | None


# What the user is told about, and why. `waiting` is the only state that
# precedes an actual pause; the rest exist so the notice never promises a wait
# the waiter is not going to perform.
class Notice(NamedTuple):
    state: str
    kind: str | None
    percent: float
    reset_at: float | None


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

def _env(name: str, default: str = "") -> str:
    return os.environ.get("USAGE_LIMIT_WAIT_" + name, default)


def _on(name: str) -> bool:
    """An opt-in flag: off unless explicitly turned on."""
    return _env(name).strip().lower() not in FALSEY


def _off(name: str) -> bool:
    """An opt-out flag: on unless explicitly turned off."""
    return _env(name).strip().lower() in FALSEY[1:]


def _number(name: str) -> float:
    try:
        return float(_env(name).strip())
    except (TypeError, ValueError):
        return DEFAULTS[name]


def _ignored_kinds() -> set[str]:
    return {part.strip().lower() for part in _env("IGNORE").split(",") if part.strip()}


def third_party_session() -> bool:
    """True when this session is billed to anything other than a subscription.

    An API key or auth token counts whenever it is set to a non-empty value;
    the provider switches are read as booleans, so `CLAUDE_CODE_USE_VERTEX=0`
    is correctly read as "not on Vertex".
    """
    if any(os.environ.get(name, "").strip() for name in API_KEY_ENV):
        return True
    return any(os.environ.get(name, "").strip().lower() not in FALSEY for name in PROVIDER_ENV)


def claude_dir() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured) if configured else Path.home() / ".claude"


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------

def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def access_token() -> str | None:
    """The subscription's OAuth access token, or None if there isn't one.

    Read fresh on every call: Claude Code rotates this file, and a wait can
    outlive the token that was current when it started.
    """
    data = _read_json(claude_dir() / ".credentials.json") or {}
    oauth = data.get("claudeAiOauth")
    if isinstance(oauth, dict):
        token = oauth.get("accessToken")
        if isinstance(token, str) and token:
            return token
    return _keychain_token()


def _keychain_token() -> str | None:
    """macOS keeps the credentials in the Keychain, not in a file."""
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout.strip())
    except ValueError:
        return None
    oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
    token = oauth.get("accessToken") if isinstance(oauth, dict) else None
    return token if isinstance(token, str) and token else None


# --------------------------------------------------------------------------
# reading usage: the API, then the CLI
# --------------------------------------------------------------------------

def fetch_usage(token: str) -> dict[str, Any] | None:
    """The raw usage payload, or None on any failure at all."""
    headers = dict(USAGE_HEADERS, Authorization="Bearer " + token)
    try:
        with urlrequest.urlopen(urlrequest.Request(USAGE_URL, headers=headers), timeout=10) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urlerror.URLError, OSError, ValueError, TimeoutError):
        return None
    return payload if isinstance(payload, dict) else None


def _percent(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _iso_to_epoch(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def snapshot_from_api(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize a usage payload into the shape the rest of the hook speaks.

    `limits[]` is the modern list and covers every window the account has;
    the older `five_hour`/`seven_day` objects are the fallback, mapped onto the
    same `kind` names so `USAGE_LIMIT_WAIT_IGNORE` means one thing.
    """
    windows = []
    for entry in payload.get("limits") or []:
        if not isinstance(entry, dict):
            continue
        percent = _percent(entry.get("percent"))
        kind = entry.get("kind")
        if percent is None or not isinstance(kind, str):
            continue
        windows.append({"kind": kind, "percent": percent, "resets_at": _iso_to_epoch(entry.get("resets_at"))})

    if not windows:
        for key, kind in (("five_hour", "session"), ("seven_day", "weekly_all")):
            entry = payload.get(key)
            if not isinstance(entry, dict):
                continue
            percent = _percent(entry.get("utilization"))
            if percent is None:
                continue
            windows.append({"kind": kind, "percent": percent, "resets_at": _iso_to_epoch(entry.get("resets_at"))})

    if not windows:
        return None
    return {"source": "api", "windows": windows, "credits": _credits_from_api(payload)}


def _credits_from_api(payload: dict[str, Any]) -> dict[str, bool] | None:
    """Pay-as-you-go state, or None when the payload doesn't say."""
    extra = payload.get("extra_usage")
    if not isinstance(extra, dict):
        return None
    return {
        "enabled": bool(extra.get("is_enabled")),
        "exhausted": bool(extra.get("spend_limit_reached")) or bool(extra.get("user_disabled")),
    }


# `claude -p /usage` renders one line per window. The separator between the
# percentage and the reset is a non-ASCII bullet, so match anything non-word.
# The clock is rendered for humans, which means a whole hour drops its minutes
# ("resets Aug 16, 4am", not "4:00am"), and the `Current ...:` prefix is what
# keeps the percentages further down the report from matching.
CLI_SUBSCRIPTION = re.compile(r"using your subscription", re.IGNORECASE)
CLI_WINDOW = re.compile(
    r"Current\s+(session|week)[^:]*:\s*(\d+(?:\.\d+)?)\s*%\s*used"
    r"(?:[^A-Za-z0-9]*resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m))?",
    re.IGNORECASE,
)
CLI_KINDS = {"session": "session", "week": "weekly_all"}


def _cli_reset_epoch(month: str, day: str, hour: str, minute: str | None, meridiem: str, now: float) -> float | None:
    """`Aug 16, 3:59am` -> epoch.

    The CLI prints the user's local time and omits the year, so the year is
    whichever one puts the reset in the future -- a reset printed in December
    and read in January belongs to the new year.
    """
    stamp = "%s %s %s:%s%s" % (month, day, hour, minute or "00", meridiem.lower())
    for year in (datetime.fromtimestamp(now).year, datetime.fromtimestamp(now).year + 1):
        try:
            parsed = datetime.strptime("%s %d" % (stamp, year), "%b %d %I:%M%p %Y")
        except ValueError:
            return None
        epoch = parsed.timestamp()
        if epoch >= now:
            return epoch
    return None


def snapshot_from_cli(text: str, now: float | None = None) -> dict[str, Any] | None:
    """Parse `claude -p /usage` output, or None if it isn't a subscription."""
    now = time.time() if now is None else now
    if not text or not CLI_SUBSCRIPTION.search(text):
        return None
    windows = []
    for match in CLI_WINDOW.finditer(text):
        window, percent, month, day, hour, minute, meridiem = match.groups()
        resets_at = None
        if month:
            resets_at = _cli_reset_epoch(month, day, hour, minute, meridiem, now)
        windows.append({
            "kind": CLI_KINDS.get(window.lower(), window.lower()),
            "percent": float(percent),
            "resets_at": resets_at,
        })
    if not windows:
        return None
    # The CLI says nothing about pay-as-you-go credits; unknown, not absent.
    return {"source": "cli", "windows": windows, "credits": None}


def read_usage_via_cli(now: float | None = None) -> dict[str, Any] | None:
    """Ask the CLI itself, for when the undocumented endpoint stops answering.

    The nested session fires `UserPromptSubmit` hooks -- this very hook -- so
    the child is spawned with the kill switch set. Without that, the hook waits
    on itself.
    """
    if _off("FALLBACK"):
        return None
    executable = shutil.which("claude")
    if not executable:
        return None
    # `USAGE_LIMIT_WAIT_DISABLE` is the recursion guard. The MSYS pair is for
    # Git Bash and friends, which rewrite an argument that looks like a POSIX
    # path before the native program sees it -- `/usage` arrives as
    # `C:/Program Files/Git/usage` and the command fails.
    child_env = dict(
        os.environ,
        USAGE_LIMIT_WAIT_DISABLE="1",
        MSYS_NO_PATHCONV="1",
        MSYS2_ARG_CONV_EXCL="*",
    )
    try:
        result = subprocess.run(
            [executable, "-p", "/usage"],
            capture_output=True, text=True, timeout=90,
            stdin=subprocess.DEVNULL, env=child_env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return snapshot_from_cli(result.stdout, now=now)


def read_usage(force: bool = False, now: float | None = None) -> dict[str, Any] | None:
    """The current snapshot, from cache when it is fresh enough.

    Returns None when usage can't be read at all, which the caller treats as
    "not our business" rather than as an error.
    """
    now = time.time() if now is None else now
    if not force:
        cached = read_cache(now)
        if cached is not None:
            return cached.get("snapshot")

    token = access_token()
    snapshot = None
    if token:
        payload = fetch_usage(token)
        if payload is not None:
            snapshot = snapshot_from_api(payload)
    if snapshot is None:
        snapshot = read_usage_via_cli(now=now)

    write_cache(snapshot, now)
    return snapshot


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

def cache_path() -> Path:
    # Usage is per-account, not per-project, so the cache is global even when
    # the hook itself was installed into one project's .claude/.
    return claude_dir() / ".usage-limit-wait.cache.json"


def cache_ttl(snapshot: dict[str, Any] | None) -> float:
    """How long a reading stays usable, scaled by how close the wall is.

    A failed reading is cached too: a session on an API key or a logged-out
    machine would otherwise pay a network round trip on every single prompt
    and tool batch, forever, to learn the same nothing.
    """
    base = _number("CACHE_TTL")
    if snapshot is None:
        return base
    peak = max((window["percent"] for window in snapshot["windows"]), default=0.0)
    if peak >= _number("THRESHOLD"):
        return min(BLOCKED_CACHE_TTL, base)
    if peak >= _number("WARN"):
        return min(ALERT_CACHE_TTL, base)
    return base


def read_cache(now: float) -> dict[str, Any] | None:
    entry = _read_json(cache_path())
    if entry is None:
        return None
    fetched_at = entry.get("fetched_at")
    if not isinstance(fetched_at, (int, float)):
        return None
    snapshot = entry.get("snapshot")
    if snapshot is not None and not _looks_like_snapshot(snapshot):
        return None
    age = now - fetched_at
    if age < 0 or age > cache_ttl(snapshot):
        return None
    return entry


def _looks_like_snapshot(value: Any) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("windows"), list):
        return False
    return all(
        isinstance(window, dict)
        and isinstance(window.get("percent"), (int, float))
        and not isinstance(window.get("percent"), bool)
        for window in value["windows"]
    )


def write_cache(snapshot: dict[str, Any] | None, now: float) -> None:
    _write_json(cache_path(), {"fetched_at": now, "snapshot": snapshot})


def _write_json(path: Path, data: Any) -> None:
    temporary = path.with_suffix(".tmp.%d" % os.getpid())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temporary, path)
    except (OSError, ValueError):
        # This is bookkeeping. Losing it costs a request or a repeated notice,
        # never a session.
        try:
            temporary.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------
# decision
# --------------------------------------------------------------------------

def evaluate(snapshot: dict[str, Any] | None) -> Verdict:
    """Is the account blocked right now, and when does that end?

    `reset_at` is the *earliest* reset among the exhausted windows. When more
    than one window is exhausted that isn't the moment work resumes, but the
    caller re-evaluates after every sleep, so the wait extends itself and picks
    up early resets for free.
    """
    if snapshot is None:
        return Verdict(False, None, None)

    if _on("USE_CREDITS"):
        credits = snapshot.get("credits")
        if isinstance(credits, dict) and credits.get("enabled") and not credits.get("exhausted"):
            # The user would rather pay than wait, and there is something to
            # pay with: Claude Code keeps working on pay-as-you-go credits.
            return Verdict(False, None, None)

    threshold = _number("THRESHOLD")
    ignored = _ignored_kinds()
    blocked = [
        window for window in snapshot["windows"]
        if window["percent"] >= threshold and str(window.get("kind", "")).lower() not in ignored
    ]
    if not blocked:
        return Verdict(False, None, None)

    datable = [window for window in blocked if isinstance(window.get("resets_at"), (int, float))]
    if not datable:
        # Exhausted with no announced reset: nothing to wait for.
        return Verdict(True, None, blocked[0].get("kind"))
    soonest = min(datable, key=lambda window: window["resets_at"])
    return Verdict(True, soonest["resets_at"], soonest.get("kind"))


def poll_interval(snapshot: dict[str, Any] | None) -> float:
    """How long to go between re-checks while waiting.

    Never below `MIN_SLEEP_SECONDS`, whatever the configuration says: a poll
    interval of zero would turn the wait into a spin on the network.
    """
    poll = max(_number("POLL"), MIN_SLEEP_SECONDS)
    if snapshot is not None and snapshot.get("source") == "cli":
        return max(poll, CLI_MIN_POLL_SECONDS)
    return poll


def wait_for_reset(
    snapshot: dict[str, Any] | None,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
    refresh: Callable[[], dict[str, Any] | None] | None = None,
) -> tuple[float, str | None]:
    """Block until the exhausted window resets. Returns (seconds, kind).

    Stops early -- and always exits 0 -- on anything unexpected: a reset
    further out than the cap (which means this is not a subscription any more)
    or the cap itself. A read failure during a confirmed wait keeps the last
    valid verdict until its announced reset; rate-limited usage endpoints and
    the CLI fallback can both become temporarily unreadable at the wall.
    """
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
        # Sleep to the announced reset, but never past one poll: Anthropic
        # hands out early resets, and a subscription can end mid-wait. The
        # floor keeps an already-past reset from spinning on the network.
        until_reset = max(verdict.reset_at + GRACE_SECONDS - now(), MIN_SLEEP_SECONDS)
        sleep(min(until_reset, poll_interval(snapshot), remaining))
        refreshed = refresh()
        if refreshed is None:
            # An exhausted account can make both the usage endpoint and the
            # `claude -p /usage` fallback temporarily unreadable. Absence of a
            # reading is not evidence that usage dropped. Keep the last valid
            # verdict until the reset it announced, then fail open if it still
            # cannot be verified.
            if now() < verdict.reset_at + GRACE_SECONDS:
                continue
            break
        snapshot = refreshed
        verdict = evaluate(refreshed)
        if verdict.blocked and verdict.kind:
            waited_for = verdict.kind

    return now() - started, waited_for


# --------------------------------------------------------------------------
# telling the user
# --------------------------------------------------------------------------

def assess(snapshot: dict[str, Any] | None, now: float) -> Notice | None:
    """What the user should be told right now, or None for "nothing".

    This deliberately re-derives the waiter's decision through `evaluate` so a
    notice can never announce a pause that is not going to happen: an exhausted
    window with no announced reset, or one that resets past the cap, produces a
    notice saying exactly that.
    """
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
        # The only way past `evaluate` at this level is the credits opt-out.
        return Notice("credits", window.get("kind"), window["percent"], window.get("resets_at"))
    if verdict.reset_at is None:
        return Notice("no-reset", verdict.kind, window["percent"], None)
    if verdict.reset_at - now > _number("MAX_WAIT"):
        return Notice("too-far", verdict.kind, window["percent"], verdict.reset_at)
    return Notice("waiting", verdict.kind, window["percent"], verdict.reset_at)


def _clock(epoch: float) -> str:
    return time.strftime("%H:%M", time.localtime(epoch))


def notice_text(notice: Notice, now: float) -> str:
    """The one line the user sees, in their own terms: window, wall, clock."""
    kind_label = WINDOW_LABELS.get(notice.kind, notice.kind) if notice.kind else "usage"
    window = "%s window is %d%% used" % (kind_label, round(notice.percent))
    if notice.state == "warn":
        if notice.reset_at is None:
            return "Claude usage: the %s. The session will pause here by itself if it runs out." % window
        return (
            "Claude usage: the %s and resets at %s, in %s. The session will pause "
            "here by itself if it runs out." % (window, _clock(notice.reset_at),
                                                format_duration(notice.reset_at - now))
        )
    if notice.state == "waiting":
        if notice.reset_at is None:
            return "Claude usage limit reached: the %s. Pausing until reset. Esc interrupts the wait." % window
        return (
            "Claude usage limit reached: the %s. Pausing until %s, about %s, then "
            "carrying on by itself. Esc interrupts the wait."
            % (window, _clock(notice.reset_at), format_duration(notice.reset_at - now))
        )
    if notice.state == "credits":
        return (
            "Claude usage limit reached: the %s. Not pausing -- USAGE_LIMIT_WAIT_USE_CREDITS "
            "is set, so this session keeps going on pay-as-you-go credits." % window
        )
    if notice.state == "too-far":
        reset_duration = format_duration(notice.reset_at - now) if notice.reset_at is not None else "a long time"
        return (
            "Claude usage limit reached: the %s and does not reset for %s, which is longer "
            "than USAGE_LIMIT_WAIT_MAX_WAIT. Not pausing."
            % (window, reset_duration)
        )
    return (
        "Claude usage limit reached: the %s, and no reset time came back with it. "
        "Not pausing." % window
    )


def notices_path() -> Path:
    return claude_dir() / ".usage-limit-wait.notices.json"


def announce_once(key: str, session_id: str, now: float, interval: float) -> bool:
    """True when this notice has not been shown recently in this session.

    Without this the warning would reappear after every prompt and every tool
    batch, which is the noise this hook exists to avoid. State is per session,
    so a second session in another project still gets told once.
    """
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


def desktop_notification(title: str, body: str) -> bool:
    """Ask the host OS to show a notification, independently of Claude Code.

    This call must finish before the wait starts: Claude Code buffers hook
    output until the process exits, but an OS notification is an immediate
    side effect. Every backend is best-effort and bounded so a broken desktop
    notifier can never hold up the session.
    """
    if _off("OS_NOTIFICATION"):
        return False

    command = None
    child_env = None
    if sys.platform == "darwin":
        executable = shutil.which("osascript")
        if executable:
            command = [
                executable,
                "-e", "on run argv",
                "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
                "-e", "end run",
                title, body,
            ]
    elif sys.platform == "win32":
        executable = shutil.which("powershell.exe") or shutil.which("powershell")
        if executable:
            # Keep user-controlled text out of the PowerShell program. The
            # fixed script reads it from the child environment and XML-escapes
            # it before handing the toast to Windows Runtime.
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
            command = [executable, "--app-name=Claude Code", title, body]

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


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def format_duration(seconds: float | int) -> str:
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return "%dh%02dm" % (hours, minutes)
    if minutes:
        return "%dm%02ds" % (minutes, seconds)
    return "%ds" % seconds


def run(session_id: str = "", now: float | None = None) -> dict[str, str] | None:
    """Report a warning, or notify and wait when a limit is exhausted."""
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

    desktop_notification(
        "Claude Code paused",
        notice_text(notice, now),
    )
    waited, kind = wait_for_reset(snapshot)
    if waited < 1:
        return None
    label = WINDOW_LABELS.get(kind, kind) if kind else "usage"
    duration = format_duration(waited)
    desktop_notification(
        "Claude Code resumed", "Waited %s for the %s limit to reset" % (duration, label),
    )
    return {
        "systemMessage": "usage-limit-wait: waited %s for the %s limit to reset."
                         % (duration, label),
    }


def hook_input() -> dict[str, Any]:
    """The event payload, or an empty one -- it is never worth failing over."""
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
    argv = sys.argv[1:] if argv is None else argv
    event = hook_input()
    try:
        if _on("DISABLE") or third_party_session():
            return 0
        # Version 1.1.0 briefly installed a parallel notifier entry. Keep an
        # updated script harmless when somebody replaces it by hand without
        # also removing that old settings entry; the --wait/default process
        # performs both jobs now.
        if "--notify" in argv:
            return 0
        payload = run(str(event.get("session_id") or ""))
    except Exception:
        # A hook that fails must never take the session with it.
        return 0
    if payload:
        # `systemMessage` goes to the user only. Plain stdout would land in the
        # model's context on UserPromptSubmit, which is the one thing this hook
        # promises not to do.
        print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
