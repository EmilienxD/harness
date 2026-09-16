from __future__ import annotations

import io
import re
import subprocess
import os
from datetime import datetime

import pytest

from harness_cli.manifest import SupportStatus, discover
from report_gotchas.cli import main
from report_gotchas.config import webhook_url
from report_gotchas.discord import deliver, messages
from report_gotchas.hooks import handle, provider_from_argv
from report_gotchas.reports import GitState, QueuedReport, load_draft, load_queued


@pytest.mark.parametrize("count", [0, 1, 10, 11, 80])
def test_discord_git_summary_counts_changes_and_shows_at_most_ten_files(count) -> None:
    status = "## main...origin/main\n" + "\n".join(
        f" M file-{index:02}.txt" for index in range(count)
    )
    report = QueuedReport(
        receipt="a" * 32, message="A caveat.", session_id="test-session",
        provider="claude", cwd="/project", reported_at="2026-09-16T12:00:00+00:00",
        git=GitState("/project", "main", "abcdef123456", status, ""),
    )
    content = "\n".join(messages(report))
    assert f"**Changed files:** {count}" in content
    assert "## main" not in content
    for index in range(min(count, 10)):
        assert f" M file-{index:02}.txt" in content
    if count > 10:
        assert "file-10.txt" not in content
        assert f"… truncated: {count - 10} more files" in content
    else:
        assert "truncated" not in content


@pytest.mark.skipif(os.name != "nt", reason="Windows console creation flags")
def test_post_tool_hook_runs_git_and_delivery_without_console_windows(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr("sys.stdin", io.StringIO("A caveat."))
    assert main(["submit"]) == 0
    receipt = capsys.readouterr().out.strip().rsplit(":", 1)[1]
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_WEBHOOK_URL", "https://discord.com/api/webhooks/123/test")
    launches = []

    def run(command, **kwargs):
        launches.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, stdout="main\n", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(subprocess, "Popen", lambda command, **kwargs: launches.append((command, kwargs)))
    handle({
        "hook_event_name": "PostToolUse", "session_id": "test-session",
        "cwd": str(tmp_path), "tool_name": "Bash",
        "tool_input": {"command": "harness-report-gotchas submit"},
        "tool_response": f"HARNESS_REPORT_GOTCHAS_RECEIPT:{receipt}",
    })
    assert any("deliver" in command for command, _ in launches)
    for _, options in launches:
        assert options.get("creationflags", 0) & subprocess.CREATE_NO_WINDOW
        assert not options.get("creationflags", 0) & subprocess.DETACHED_PROCESS


@pytest.mark.parametrize(
    "argv, expected",
    [
        (["--claude"], "claude"),
        (["--chatgpt"], "chatgpt"),
        ([], None),
        # Anything that is not the flag is not a provider, including the bare
        # word older settings used to pass.
        (["claude"], None),
        (["chatgpt"], None),
        (["--verbose"], None),
    ],
)
def test_provider_comes_from_the_flag_the_installer_writes(argv, expected) -> None:
    assert provider_from_argv(argv) == expected


def test_submit_accepts_markdown_on_stdin_and_returns_an_opaque_receipt(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(tmp_path))
    markdown = "## ⚠️ Gotchas\n\nWindows quoting changed the payload.\n"
    monkeypatch.setattr("sys.stdin", io.StringIO(markdown))

    assert main(["submit"]) == 0

    output = capsys.readouterr().out.strip()
    match = re.fullmatch(r"HARNESS_REPORT_GOTCHAS_RECEIPT:([0-9a-f]{32})", output)
    assert match is not None
    assert load_draft(match.group(1)).message == markdown


def test_submit_decodes_redirected_stdin_as_utf8_when_the_shell_locale_is_legacy(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(tmp_path))
    markdown = "## Gotchas\n\nUnicode survives: ⚠️ 🐛\n"
    stdin = io.TextIOWrapper(
        io.BytesIO(markdown.encode("utf-8")), encoding="cp1252", errors="surrogateescape"
    )
    monkeypatch.setattr("sys.stdin", stdin)

    assert main(["submit"]) == 0

    receipt = capsys.readouterr().out.strip().rsplit(":", 1)[1]
    assert load_draft(receipt).message == markdown


def test_post_tool_hook_binds_receipt_to_session_and_local_git_state(
    tmp_path, monkeypatch, capsys
) -> None:
    state = tmp_path / "state"
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(state))
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "tests@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Tests"], cwd=repo, check=True)
    (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "remote", "add", "origin", "https://token:secret@github.com/example/project.git"],
        cwd=repo,
        check=True,
    )
    (repo / "loose.txt").write_text("untracked\n", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("## 🐛 Bugs\n\nA real bug.\n"))
    assert main(["submit"]) == 0
    receipt = capsys.readouterr().out.strip().rsplit(":", 1)[1]
    launched: list[str] = []

    output = handle(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "thr_codex_123",
            "cwd": str(repo),
            "tool_name": "Bash",
            "tool_input": {"command": "harness-report-gotchas submit <<'EOF'\n...\nEOF"},
            "tool_response": {"output": f"HARNESS_REPORT_GOTCHAS_RECEIPT:{receipt}\n"},
        },
        "chatgpt",
        launch_worker=launched.append,
    )

    queued = load_queued(receipt)
    assert output is not None and "queued for Discord" in str(output)
    assert launched == [receipt]
    assert queued.session_id == "thr_codex_123"
    assert queued.provider == "chatgpt"
    assert datetime.fromisoformat(queued.reported_at).tzinfo is not None
    assert queued.git.branch == "main"
    assert re.fullmatch(r"[0-9a-f]{40}", queued.git.commit)
    assert "?? loose.txt" in queued.git.status
    assert queued.git.remote == "https://github.com/example/project.git"
    assert not (state / "drafts" / f"{receipt}.json").exists()


def test_delivery_splits_long_reports_into_ordered_discord_messages_and_removes_source(
    tmp_path, monkeypatch, capsys
) -> None:
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(state))
    marker_a = "FIRST-GOTCHA"
    marker_b = "LAST-HUMAN-ACTION"
    message = (
        f"## ⚠️ Gotchas\n\n{marker_a}\n"
        + ("😀" * 2100)
        + ("\ndetail line\n" * 450)
        + f"\n## 🙋 Human action required\n\n{marker_b}\n"
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(message))
    assert main(["submit"]) == 0
    receipt = capsys.readouterr().out.strip().rsplit(":", 1)[1]
    handle(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "claude-session-456",
            "cwd": str(tmp_path),
            "tool_name": "Bash",
            "tool_input": {"command": "harness-report-gotchas submit <<'EOF'"},
            "tool_response": f"HARNESS_REPORT_GOTCHAS_RECEIPT:{receipt}",
        },
        "claude",
    )
    requests: list[tuple[str, dict]] = []

    deliver(
        receipt,
        "https://discord.com/api/webhooks/123/secret",
        post=lambda url, payload: requests.append((url, payload)),
    )

    assert len(requests) >= 3
    assert all(url.endswith("?wait=true") for url, _payload in requests)
    assert all(
        len(payload["content"].encode("utf-16-le")) // 2 <= 2000
        for _url, payload in requests
    )
    assert all(payload["allowed_mentions"] == {"parse": []} for _url, payload in requests)
    contents = "\n".join(payload["content"] for _url, payload in requests)
    assert contents.index(marker_a) < contents.index(marker_b)
    assert "**Claude:** claude-session-456" in requests[0][1]["content"]
    assert "**Date:** <t:" in requests[0][1]["content"]
    assert "**Git:**" in requests[0][1]["content"]
    assert not (state / "queue" / f"{receipt}.json").exists()


def test_delivery_resumes_after_the_last_confirmed_discord_message(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr("sys.stdin", io.StringIO("## ⚠️ Gotchas\n\n" + ("long line\n" * 500)))
    assert main(["submit"]) == 0
    receipt = capsys.readouterr().out.strip().rsplit(":", 1)[1]
    handle(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "thr-retry",
            "cwd": str(tmp_path),
            "tool_name": "Bash",
            "tool_input": {"command": "harness-report-gotchas submit"},
            "tool_response": f"HARNESS_REPORT_GOTCHAS_RECEIPT:{receipt}",
        },
        "chatgpt",
    )
    first_attempt: list[str] = []

    def fail_second(_url: str, payload: dict) -> None:
        first_attempt.append(payload["content"])
        if len(first_attempt) == 2:
            raise OSError("temporary network failure")

    with pytest.raises(OSError, match="temporary network failure"):
        deliver(receipt, "https://discord.com/api/webhooks/123/secret", post=fail_second)

    assert load_queued(receipt).next_message == 1
    resumed: list[str] = []
    deliver(
        receipt,
        "https://discord.com/api/webhooks/123/secret",
        post=lambda _url, payload: resumed.append(payload["content"]),
    )
    assert resumed[0] == first_attempt[1]


def test_configure_reads_the_webhook_secret_without_echoing_it(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("HARNESS_REPORT_GOTCHAS_STATE_DIR", str(tmp_path))
    secret = "https://discord.com/api/webhooks/123/super-secret-token"
    monkeypatch.setattr("sys.stdin", io.StringIO(secret + "\n"))

    assert main(["configure"]) == 0

    output = capsys.readouterr().out
    assert secret not in output
    assert webhook_url() == secret


def test_catalogue_exposes_model_invokable_dual_platform_skill_and_runtime() -> None:
    tool = discover()["report-gotchas"]
    assert tool.version == "1.1.4"
    assert tool.support_for("claude").status is SupportStatus.SUPPORTED
    assert tool.support_for("chatgpt").status is SupportStatus.SUPPORTED
    assert tool.requires == ("git",)
    assert len(tool.actions) == 1
    assert tool.actions[0].data["package"] == "harness-report-gotchas-runtime"

    for platform in ("claude", "chatgpt"):
        files = {entry.dest: entry.source for entry in tool.expand(platform)}
        skill = files["report-gotchas/SKILL.md"].read_text(encoding="utf-8")
        assert "disable-model-invocation" not in skill
        assert "harness-report-gotchas submit" in skill
        hooks = tool.fragment_for(platform)["hooks"]["PostToolUse"]
        assert hooks[0]["matcher"] in {"Bash", "Bash|PowerShell"}
    chatgpt = {entry.dest: entry.source for entry in tool.expand("chatgpt")}
    assert "allow_implicit_invocation: true" in chatgpt[
        "report-gotchas/agents/openai.yaml"
    ].read_text(encoding="utf-8")
