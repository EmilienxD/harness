"""Tests for the usage-limit-wait hook.

The hook's whole job is to block a session for hours, so every test here runs
against injected clocks, injected refreshes, and stubbed subprocesses: nothing
sleeps, and nothing touches the network. What is actually being pinned down is
the decision -- when to wait, for how long, and the much longer list of cases
where the hook must do nothing at all.
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import pytest

HOOK = (
    Path(__file__).resolve().parent.parent
    / "harness" / "usage-limit-wait" / "hooks" / "usage_limit_wait_hook.py"
)

sys.path.insert(0, str(HOOK.parent))
import usage_limit_wait_hook as hook  # noqa: E402

CLI_OUTPUT = (
    "You are currently using your subscription to power your Claude Code usage\n"
    "Current session: 10% used · resets Aug 16, 3:59am (Europe/Paris)\n"
    "Current week (all models): 22% used · resets Aug 20, 8:59pm (Europe/Paris)\n"
)

# Captured verbatim from `claude -p /usage`. Two things here that the tidied
# sample above doesn't show: a whole hour prints without minutes ("4am"), and
# the report below the windows is full of percentages that must not be mistaken
# for usage windows.
CLI_OUTPUT_REAL = (
    "You are currently using your subscription to power your Claude Code usage\n"
    "\n"
    "Current session: 19% used · resets Aug 16, 4am (Europe/Paris)\n"
    "Current week (all models): 23% used · resets Aug 20, 9pm (Europe/Paris)\n"
    "\n"
    "What's contributing to your limits usage?\n"
    "Approximate, based on local sessions on this machine.\n"
    "\n"
    "Last 24h · 370 requests · 38 sessions\n"
    "  88% of your usage came from subagent-heavy sessions\n"
    "  70% of your usage was at >150k context\n"
    "  Top subagents: Explore 12%\n"
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """No inherited configuration, and a cache that lives in tmp_path."""
    for name in list(sys.modules["os"].environ):
        if name.startswith("USAGE_LIMIT_WAIT_"):
            monkeypatch.delenv(name, raising=False)
    for name in hook.API_KEY_ENV + hook.PROVIDER_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    return tmp_path


def snapshot(*windows, source="api", credits=None):
    return {
        "source": source,
        "windows": [
            {"kind": kind, "percent": percent, "resets_at": resets_at}
            for kind, percent, resets_at in windows
        ],
        "credits": credits,
    }


class Clock:
    """A fake clock that only moves when something sleeps."""

    def __init__(self, start=1_000_000.0):
        self.now = start
        self.slept = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------

@pytest.mark.parametrize("name", hook.API_KEY_ENV)
def test_api_key_sessions_are_not_ours(monkeypatch, name):
    monkeypatch.setenv(name, "sk-whatever")
    assert hook.third_party_session() is True


@pytest.mark.parametrize("name", hook.PROVIDER_ENV)
def test_provider_switches_are_read_as_booleans(monkeypatch, name):
    monkeypatch.setenv(name, "1")
    assert hook.third_party_session() is True
    monkeypatch.setenv(name, "0")
    assert hook.third_party_session() is False


def test_subscription_session_passes_the_guards():
    assert hook.third_party_session() is False


def test_run_exits_before_reading_anything_when_a_provider_is_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-whatever")
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: pytest.fail("read usage anyway"))
    assert hook.run() is None


def test_run_exits_immediately_when_disabled(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_DISABLE", "1")
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: pytest.fail("read usage anyway"))
    assert hook.run() is None


def test_unreadable_usage_is_not_an_error(monkeypatch):
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: None)
    assert hook.run() is None


# --------------------------------------------------------------------------
# evaluate
# --------------------------------------------------------------------------

def test_exhausted_window_blocks_until_its_reset():
    verdict = hook.evaluate(snapshot(("session", 100.0, 5_000.0), ("weekly_all", 21.0, 9_000.0)))
    assert verdict == hook.Verdict(True, 5_000.0, "session")


def test_threshold_is_inclusive_and_defaults_to_98():
    assert hook.evaluate(snapshot(("session", 98.0, 5_000.0))).blocked is True
    assert hook.evaluate(snapshot(("session", 97.9, 5_000.0))).blocked is False


def test_threshold_is_configurable(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_THRESHOLD", "100")
    assert hook.evaluate(snapshot(("session", 98.0, 5_000.0))).blocked is False


def test_the_soonest_reset_wins_when_several_windows_are_exhausted():
    verdict = hook.evaluate(snapshot(("weekly_all", 100.0, 9_000.0), ("session", 100.0, 5_000.0)))
    assert verdict.reset_at == 5_000.0


def test_ignored_kinds_are_never_waited_on(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_IGNORE", "weekly_all")
    assert hook.evaluate(snapshot(("weekly_all", 100.0, 9_000.0))).blocked is False
    assert hook.evaluate(snapshot(("session", 100.0, 5_000.0))).blocked is True


def test_exhausted_without_an_announced_reset_is_blocked_but_undatable():
    verdict = hook.evaluate(snapshot(("session", 100.0, None)))
    assert verdict.blocked is True and verdict.reset_at is None


# --------------------------------------------------------------------------
# the credits rule
# --------------------------------------------------------------------------

LIVE = {"enabled": True, "exhausted": False}
SPENT = {"enabled": True, "exhausted": True}


def test_credits_are_not_spent_unless_asked():
    assert hook.evaluate(snapshot(("session", 100.0, 5_000.0), credits=LIVE)).blocked is True


def test_opting_into_credits_skips_the_wait(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_USE_CREDITS", "1")
    assert hook.evaluate(snapshot(("session", 100.0, 5_000.0), credits=LIVE)).blocked is False


@pytest.mark.parametrize("credits", [SPENT, {"enabled": False, "exhausted": False}, None])
def test_opting_in_still_waits_when_there_is_nothing_to_spend(monkeypatch, credits):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_USE_CREDITS", "1")
    assert hook.evaluate(snapshot(("session", 100.0, 5_000.0), credits=credits)).blocked is True


def test_a_cli_snapshot_knows_nothing_about_credits(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_USE_CREDITS", "1")
    parsed = hook.snapshot_from_cli(CLI_OUTPUT)
    assert parsed["credits"] is None
    assert hook.evaluate(snapshot(("session", 100.0, 5_000.0), source="cli")).blocked is True


# --------------------------------------------------------------------------
# reading the API payload
# --------------------------------------------------------------------------

def test_api_payload_is_normalized_from_the_limits_array():
    payload = {
        "limits": [
            {"kind": "session", "percent": 2, "resets_at": "2026-08-16T01:59:59.806753+00:00"},
            {"kind": "weekly_all", "percent": 21, "resets_at": "2026-08-20T18:59:59.806773+00:00"},
        ],
        "extra_usage": {"is_enabled": False, "user_disabled": True, "spend_limit_reached": False},
    }
    parsed = hook.snapshot_from_api(payload)
    assert [window["kind"] for window in parsed["windows"]] == ["session", "weekly_all"]
    assert parsed["windows"][0]["percent"] == 2.0
    assert parsed["windows"][0]["resets_at"] == datetime.fromisoformat(
        "2026-08-16T01:59:59.806753+00:00"
    ).timestamp()
    assert parsed["credits"] == {"enabled": False, "exhausted": True}


def test_api_payload_falls_back_to_the_window_objects():
    payload = {
        "five_hour": {"utilization": 100.0, "resets_at": "2026-08-16T01:59:59+00:00"},
        "seven_day": {"utilization": 21.0, "resets_at": "2026-08-20T18:59:59+00:00"},
    }
    parsed = hook.snapshot_from_api(payload)
    assert [window["kind"] for window in parsed["windows"]] == ["session", "weekly_all"]
    assert hook.evaluate(parsed).kind == "session"


def test_an_unrecognisable_payload_yields_nothing():
    assert hook.snapshot_from_api({"limits": [], "spend": {}}) is None
    assert hook.snapshot_from_api({"limits": [{"kind": "session", "percent": None}]}) is None


# --------------------------------------------------------------------------
# the `claude -p /usage` fallback
# --------------------------------------------------------------------------

def test_cli_output_is_parsed_into_both_windows():
    now = datetime(2026, 8, 15, 12, 0).timestamp()
    parsed = hook.snapshot_from_cli(CLI_OUTPUT, now=now)
    assert parsed["source"] == "cli"
    assert [(window["kind"], window["percent"]) for window in parsed["windows"]] == [
        ("session", 10.0), ("weekly_all", 22.0)
    ]
    assert parsed["windows"][0]["resets_at"] == datetime(2026, 8, 16, 3, 59).timestamp()
    assert parsed["windows"][1]["resets_at"] == datetime(2026, 8, 20, 20, 59).timestamp()


def test_real_cli_output_parses_whole_hours_and_ignores_the_report():
    now = datetime(2026, 8, 15, 12, 0).timestamp()
    parsed = hook.snapshot_from_cli(CLI_OUTPUT_REAL, now=now)
    # Only the two windows -- not the "88% of your usage ..." lines below them.
    assert [(window["kind"], window["percent"]) for window in parsed["windows"]] == [
        ("session", 19.0), ("weekly_all", 23.0)
    ]
    assert parsed["windows"][0]["resets_at"] == datetime(2026, 8, 16, 4, 0).timestamp()
    assert parsed["windows"][1]["resets_at"] == datetime(2026, 8, 20, 21, 0).timestamp()


def test_cli_reset_rolls_into_next_year_when_the_date_has_passed():
    now = datetime(2026, 12, 31, 23, 0).timestamp()
    parsed = hook.snapshot_from_cli(
        "using your subscription\nCurrent session: 99% used · resets Jan 1, 2:00am (UTC)\n", now=now
    )
    assert parsed["windows"][0]["resets_at"] == datetime(2027, 1, 1, 2, 0).timestamp()


def test_cli_output_from_a_non_subscription_session_yields_nothing():
    assert hook.snapshot_from_cli("You are using an API key to power your Claude Code usage") is None
    assert hook.snapshot_from_cli("") is None


def test_cli_fallback_disables_itself_in_the_child(monkeypatch):
    calls = {}

    class Result:
        returncode = 0
        stdout = CLI_OUTPUT

    def fake_run(argv, **kwargs):
        calls["argv"] = argv
        calls["env"] = kwargs["env"]
        return Result()

    monkeypatch.setattr(hook.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(hook.subprocess, "run", fake_run)

    parsed = hook.read_usage_via_cli()
    assert parsed["source"] == "cli"
    assert calls["argv"] == ["/usr/bin/claude", "-p", "/usage"]
    # Without this the nested session runs this very hook and waits on itself.
    assert calls["env"]["USAGE_LIMIT_WAIT_DISABLE"] == "1"
    # Under Git Bash, `/usage` is otherwise rewritten into a Windows path.
    assert calls["env"]["MSYS_NO_PATHCONV"] == "1"
    assert calls["env"]["MSYS2_ARG_CONV_EXCL"] == "*"


def test_cli_fallback_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_FALLBACK", "0")
    monkeypatch.setattr(hook.shutil, "which", lambda name: pytest.fail("looked for the CLI anyway"))
    assert hook.read_usage_via_cli() is None


def test_read_usage_prefers_the_api_and_falls_back_to_the_cli(monkeypatch):
    monkeypatch.setattr(hook, "access_token", lambda: "token")
    monkeypatch.setattr(hook, "fetch_usage", lambda token: {"limits": [
        {"kind": "session", "percent": 3, "resets_at": "2026-08-16T01:59:59+00:00"}]})
    monkeypatch.setattr(hook, "read_usage_via_cli", lambda **kwargs: pytest.fail("used the fallback"))
    assert hook.read_usage(force=True)["source"] == "api"

    monkeypatch.setattr(hook, "fetch_usage", lambda token: None)
    monkeypatch.setattr(hook, "read_usage_via_cli", lambda **kwargs: hook.snapshot_from_cli(CLI_OUTPUT))
    assert hook.read_usage(force=True)["source"] == "cli"


def test_read_usage_without_a_token_still_tries_the_cli(monkeypatch):
    monkeypatch.setattr(hook, "access_token", lambda: None)
    monkeypatch.setattr(hook, "fetch_usage", lambda token: pytest.fail("called the API without a token"))
    monkeypatch.setattr(hook, "read_usage_via_cli", lambda **kwargs: None)
    assert hook.read_usage(force=True) is None


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

def test_a_fresh_reading_is_served_from_cache(monkeypatch):
    fresh = snapshot(("session", 3.0, 5_000.0))
    hook.write_cache(fresh, now=1_000.0)
    monkeypatch.setattr(hook, "access_token", lambda: pytest.fail("refetched a fresh reading"))
    assert hook.read_usage(now=1_100.0) == fresh


def test_a_stale_reading_is_refetched(monkeypatch):
    hook.write_cache(snapshot(("session", 3.0, 5_000.0)), now=1_000.0)
    monkeypatch.setattr(hook, "access_token", lambda: None)
    monkeypatch.setattr(hook, "read_usage_via_cli", lambda **kwargs: None)
    assert hook.read_usage(now=1_000.0 + hook.DEFAULTS["CACHE_TTL"] + 1) is None


def test_an_exhausted_reading_is_never_cached():
    hook.write_cache(snapshot(("session", 100.0, 5_000.0)), now=1_000.0)
    assert hook.read_cache(now=1_000.5) is None


def test_a_near_the_wall_reading_is_cached_only_briefly():
    hook.write_cache(snapshot(("session", 95.0, 5_000.0)), now=1_000.0)
    assert hook.read_cache(now=1_000.0 + hook.ALERT_CACHE_TTL - 1) is not None
    assert hook.read_cache(now=1_000.0 + hook.ALERT_CACHE_TTL + 1) is None


def test_failures_are_cached_so_a_non_subscription_machine_stops_asking(monkeypatch):
    hook.write_cache(None, now=1_000.0)
    monkeypatch.setattr(hook, "access_token", lambda: pytest.fail("retried a cached failure"))
    assert hook.read_usage(now=1_010.0) is None


def test_a_corrupt_cache_is_ignored():
    hook.cache_path().parent.mkdir(parents=True, exist_ok=True)
    hook.cache_path().write_text("{not json", encoding="utf-8")
    assert hook.read_cache(now=1_000.0) is None


# --------------------------------------------------------------------------
# the wait loop
# --------------------------------------------------------------------------

def test_it_sleeps_until_the_reset_then_returns_when_usage_drops(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "7200")  # no polling in between
    clock = Clock()
    reset_at = clock.now + 3600
    exhausted = snapshot(("session", 100.0, reset_at))
    refreshed = snapshot(("session", 0.0, reset_at + 18_000))

    waited, kind = hook.wait_for_reset(
        exhausted, now=clock.time, sleep=clock.sleep, refresh=lambda: refreshed
    )
    assert clock.slept == [3600 + hook.GRACE_SECONDS]
    assert waited == pytest.approx(3610)
    assert kind == "session"


def test_a_distant_reset_is_still_re_checked_every_poll(monkeypatch):
    """Anthropic grants early resets, so a long wait must not sleep blind."""
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "60")
    clock = Clock()
    exhausted = snapshot(("session", 100.0, clock.now + 3600))
    polls = []

    def refresh():
        polls.append(clock.now)
        # Third check: the window was reset early.
        return exhausted if len(polls) < 3 else snapshot(("session", 1.0, clock.now + 18_000))

    waited, _ = hook.wait_for_reset(
        exhausted, now=clock.time, sleep=clock.sleep, refresh=refresh
    )
    assert clock.slept == [60, 60, 60]
    assert waited == pytest.approx(180)


def test_it_keeps_polling_while_the_limit_holds(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "7200")
    clock = Clock()
    reset_at = clock.now + 3600
    exhausted = snapshot(("session", 100.0, reset_at))
    # The announced reset came and went and the account is still exhausted --
    # so the wait extends itself instead of handing back a still-blocked session.
    later = snapshot(("session", 100.0, reset_at + 600))
    answers = [later, snapshot(("session", 4.0, reset_at + 18_000))]

    waited, _ = hook.wait_for_reset(
        exhausted, now=clock.time, sleep=clock.sleep, refresh=lambda: answers.pop(0)
    )
    assert len(clock.slept) == 2
    assert waited == pytest.approx(3610 + 600)
    assert answers == []


def test_a_reset_beyond_the_cap_means_no_subscription(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_MAX_WAIT", "60")
    clock = Clock()
    exhausted = snapshot(("session", 100.0, clock.now + 3600))
    waited, _ = hook.wait_for_reset(
        exhausted, now=clock.time, sleep=clock.sleep,
        refresh=lambda: pytest.fail("polled anyway"),
    )
    assert clock.slept == [] and waited == 0


def test_an_undatable_limit_is_not_waited_on():
    clock = Clock()
    waited, _ = hook.wait_for_reset(
        snapshot(("session", 100.0, None)), now=clock.time, sleep=clock.sleep,
        refresh=lambda: pytest.fail("polled anyway"),
    )
    assert clock.slept == [] and waited == 0


def test_the_wait_ends_when_usage_stops_being_readable():
    clock = Clock()
    exhausted = snapshot(("session", 100.0, clock.now + 60))
    waited, _ = hook.wait_for_reset(
        exhausted, now=clock.time, sleep=clock.sleep, refresh=lambda: None
    )
    assert len(clock.slept) == 1 and waited > 0


def test_the_cap_bounds_a_limit_that_never_clears(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_MAX_WAIT", "300")
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "60")
    clock = Clock()
    stuck = snapshot(("session", 100.0, clock.now - 10))  # reset already "passed"
    waited, _ = hook.wait_for_reset(stuck, now=clock.time, sleep=clock.sleep, refresh=lambda: stuck)
    assert waited == pytest.approx(300)
    # Never spins: a reset in the past still costs a full minimum sleep.
    assert min(clock.slept) >= hook.MIN_SLEEP_SECONDS


def test_polling_slows_down_on_the_cli_fallback(monkeypatch):
    monkeypatch.setenv("USAGE_LIMIT_WAIT_POLL", "60")
    assert hook.poll_interval(snapshot(("session", 100.0, 1.0))) == 60
    assert hook.poll_interval(snapshot(("session", 100.0, 1.0), source="cli")) == hook.CLI_MIN_POLL_SECONDS


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------

def test_a_completed_wait_reports_itself_to_the_user_only(monkeypatch, capsys):
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: snapshot(("session", 100.0, time.time() + 30)))
    monkeypatch.setattr(hook, "wait_for_reset", lambda *a, **k: (3600 * 3 + 720, "session"))
    assert hook.main() == 0
    printed = json.loads(capsys.readouterr().out)
    # `systemMessage` reaches the user; nothing here reaches the model.
    assert list(printed) == ["systemMessage"]
    assert "3h12m" in printed["systemMessage"] and "5-hour" in printed["systemMessage"]


def test_the_common_path_prints_nothing(monkeypatch, capsys):
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: snapshot(("session", 2.0, time.time() + 30)))
    assert hook.main() == 0
    assert capsys.readouterr().out == ""


def test_an_unexpected_failure_never_breaks_the_session(monkeypatch, capsys):
    monkeypatch.setattr(hook, "read_usage", lambda *a, **k: 1 / 0)
    assert hook.main() == 0
    assert capsys.readouterr().out == ""


def test_durations_read_like_durations():
    assert hook.format_duration(45) == "45s"
    assert hook.format_duration(125) == "2m05s"
    assert hook.format_duration(3600 * 4 + 60 * 7) == "4h07m"
