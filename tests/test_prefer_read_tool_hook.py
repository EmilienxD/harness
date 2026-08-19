"""Tests for the prefer-read-tool hook."""
import io
import json
import sys
from pathlib import Path

import pytest

HOOK_DIR = (
    Path(__file__).resolve().parent.parent
    / "harness" / "prefer-read-tool" / "hooks"
)

sys.path.insert(0, str(HOOK_DIR))

import prefer_read_tool_PostToolUse_hook as hook  # noqa: E402


def run_hook(payload, raw=None):
    """Invoke main() with a stdin payload, returning (exit_code, parsed stdout)."""
    old_stdin, old_stdout = sys.stdin, sys.stdout
    cap = io.StringIO()
    sys.stdin = io.StringIO(raw if raw is not None else json.dumps(payload))
    sys.stdout = cap
    try:
        code = hook.main()
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
    out = cap.getvalue().strip()
    return code, json.loads(out) if out else None


def shell(command, tool="Bash"):
    return {
        "hook_event_name": "PostToolUse",
        "tool_name": tool,
        "tool_input": {"command": command},
    }


READ_COMMANDS = [
    "cat README.md",
    "sed -n '1,50p' src/app.ts",
    "awk 'NR >= 10 && NR <= 40 { print }' src/app.ts",
    "gawk 'NR <= 20' data.tsv",
    "head -n 20 README.md",
    "tail -50 logs/app.log",
    "nl -ba README.md",
    "foo; head README.md",
    "echo $(tail -n 5 CHANGELOG.md)",
    "printf '%s\n' $(nl README.md)",
]


POWERSHELL_READ_COMMANDS = [
    "Get-Content README.md",
    "Cat README.md",
    "gc README.md -Head 20",
    "Get-Content README.md -Tail 20",
    "type README.md",
    "Select-String -Path src/app.ts -Pattern TODO",
    "sls TODO src/app.ts",
    "[IO.File]::ReadAllText($path)",
    "[System.IO.File]::ReadLines($path)",
]


@pytest.mark.parametrize("command", READ_COMMANDS)
def test_shell_file_read_commands_get_a_reminder(command):
    code, out = run_hook(shell(command))
    assert code == 0
    assert out is not None, f"no reminder for: {command}"
    extra = out["hookSpecificOutput"]["additionalContext"]
    assert "Read tool" in extra


@pytest.mark.parametrize("command", POWERSHELL_READ_COMMANDS)
def test_powershell_file_read_commands_get_a_reminder(command):
    code, out = run_hook(shell(command, tool="PowerShell"))
    assert code == 0
    assert out is not None, f"no reminder for: {command}"
    extra = out["hookSpecificOutput"]["additionalContext"]
    assert "PowerShell" in extra


@pytest.mark.parametrize("command", [
    "echo concatenate",
    "rg --type py TODO",
    "rg --type-add 'foo:*.foo' x",
    "echo 'the word head appears here'",
    "echo 'awkward phrasing'",
    "echo 'nl is short for numbered lines'",
])
def test_non_command_words_stay_quiet(command):
    assert run_hook(shell(command)) == (0, None)


@pytest.mark.parametrize("payload", [
    {},
    {"tool_input": None},
    {"tool_input": {}},
    {"tool_input": {"command": ""}},
    {"tool_input": {"command": 42}},
    {"tool_input": "cat f"},
])
def test_malformed_input_is_ignored(payload):
    assert run_hook(payload) == (0, None)


@pytest.mark.parametrize("raw", ["", "not json", "null", "[1, 2]"])
def test_unparseable_stdin_is_ignored(raw):
    assert run_hook(None, raw=raw) == (0, None)
