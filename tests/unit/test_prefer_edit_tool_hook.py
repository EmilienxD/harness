"""Tests for the prefer-edit-tool hook.

The hook is a standalone script inside `.claude/hooks/`, so it's imported by
path like the other harness hook tests. What's pinned down is the detection:
which shell commands are treated as file writes, which are left alone, and
that malformed hook input never produces output.
"""
import io
import json
import sys
from pathlib import Path

import pytest

HOOK_DIR = (
    Path(__file__).resolve().parents[2]
    / "harness" / "guards" / "prefer-edit-tool"
)

sys.path.insert(0, str(HOOK_DIR))

import prefer_edit_tool_hook as hook  # noqa: E402


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


def bash(command, event="PostToolUse", tool="Bash"):
    return {
        "hook_event_name": event,
        "tool_name": tool,
        "tool_input": {"command": command},
    }


WRITES = [
    # heredocs and redirects
    "cat > notes.md <<'EOF'\nhello\nEOF",
    "cat <<'EOF' > src/app.ts\nexport const a = 1;\nEOF",
    "printf 'x\\n' >> CHANGELOG.md",
    'echo "text" > "path with spaces.txt"',
    "cat old.txt | sudo tee /etc/hosts",
    # in-place stream editors
    "sed -i 's/a/b/' config.yml",
    "sed -i.bak -e 's/a/b/' config.yml",
    "perl -pi -e 's/a/b/' config.yml",
    "awk -i inplace '{print}' f.txt",
    # ... including when they hide inside a loop, a pipe, or -exec
    "for f in *.md; do sed -i 's/a/b/' $f; done",
    "find . -name '*.py' | xargs sed -i 's/a/b/'",
    "find . -name '*.ts' -exec perl -pi -e 's/a/b/' {} +",
    # inline python -- the case worth catching
    "python3 - <<'PY'\nopen('f.txt', 'w').write('x')\nPY",
    'python3 -c "open(\'f.txt\', \'w\').write(\'x\')"',
    "python - <<PY\nfrom pathlib import Path\nPath('f').write_text('x')\nPY",
    "python3 - <<'PY'\nwith open(p, 'a') as fh:\n    fh.write(line)\nPY",
    "uv run python -c \"import json; json.dump(d, open('f','w'))\"",
    "python3 - <<'PY'\nimport fileinput\nfor line in fileinput.input('f', inplace=True):\n    pass\nPY",
    # inline node / bun / deno
    "node -e \"require('fs').writeFileSync('f','x')\"",
    "node -e \"const fs = require('fs'); fs.appendFileSync('f', 'x')\"",
    "node --input-type=module -e \"import {writeFile} from 'node:fs/promises'; await writeFile('f','x')\"",
    "node -e \"fs.promises.writeFile('f', 'x')\"",
    "node -e \"fs.openSync('f', 'w')\"",
    "node -e \"fs.createWriteStream('f').write('x')\"",
    "npx tsx -e \"await fsp.rename('a','b')\"",
    "bun -e \"await Bun.write('f', 'x')\"",
    "deno eval \"await Deno.writeTextFile('f', 'x')\"",
    # powershell
    "Set-Content -Path f.txt -Value 'hello'",
    "Add-Content settings.json '{}'",
    "'x' | Out-File -Encoding utf8 f.txt",
    "[IO.File]::WriteAllText($p, $text)",
    "New-Item -ItemType File -Path f.txt -Value 'x'",
    # patches and byte-level writes
    "git apply fix.patch",
    "patch -p1 < fix.patch",
    "dd if=/dev/zero of=disk.img bs=1M count=1",
]

READS = [
    "cat README.md",
    "sed -n '1,50p' src/app.ts",
    "grep -rn 'foo' src/ 2>/dev/null",
    "ls -la > /dev/null",
    "npm test 2>&1",
    "git log --oneline | head -5",
    "python3 -c \"print(open('f.txt').read())\"",
    "python3 -c 'x = 1 >> 2'",
    "python3 - <<'PY'\nif len(xs) >= 5:\n    print(xs)\nPY",
    "echo 'a -> b'",
    "echo 'Vec<T> and () => {}'",
    "grep -c '</div>' index.html",
    "make build 2> errors.log",
    "curl -sL https://example.com/x.tgz -o x.tgz",
    "Get-Content f.txt | Select-Object -First 5",
    "Get-ChildItem -Recurse | Where-Object { $_.Length -gt 100 }",
    "curl -s https://example.com | jq '.items'",
    "uv run pytest",
    "git diff --stat",
]


@pytest.mark.parametrize("command", WRITES)
def test_file_writes_get_a_reminder(command):
    code, out = run_hook(bash(command))
    assert code == 0
    assert out is not None, f"no reminder for: {command}"
    extra = out["hookSpecificOutput"]["additionalContext"]
    assert "Write and Edit tools" in extra


@pytest.mark.parametrize("command", READS)
def test_read_only_commands_stay_quiet(command):
    code, out = run_hook(bash(command))
    assert code == 0
    assert out is None, f"unexpected reminder for: {command}"


def test_reminder_names_the_signal_it_saw():
    _, out = run_hook(bash("cat > notes.md <<'EOF'\nhi\nEOF"))
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"

    _, out = run_hook(bash("sed -i 's/a/b/' f.yml"))
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"


@pytest.mark.parametrize("mode", ["w", "a", "x", "wb", "r+", "a+b"])
def test_every_non_read_open_mode_counts(mode):
    """Append and update modes are writes too, not just truncating "w"."""
    _, out = run_hook(bash(f"python3 -c \"open('f', '{mode}')\""))
    assert out is not None, mode


@pytest.mark.parametrize("command", [
    "grep -rn '.write(' src/",
    "grep -rn 'writeFileSync' src/",
    "rg 'Deno.writeTextFile' .",
])
def test_interpreter_writes_need_an_interpreter(command):
    """Grepping for the literal text of a write call isn't a write."""
    assert run_hook(bash(command)) == (0, None)


def test_failure_event_is_echoed_back():
    _, out = run_hook(bash("sed -i 's/a/b/' f.yml", event="PostToolUseFailure"))
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUseFailure"


def test_unknown_event_falls_back_to_posttooluse():
    _, out = run_hook(bash("sed -i 's/a/b/' f.yml", event="Whatever"))
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"


def test_powershell_tool_is_handled_like_bash():
    _, out = run_hook(bash("Set-Content f.txt 'x'", tool="PowerShell"))
    assert out is not None


@pytest.mark.parametrize("payload", [
    {},
    {"tool_input": None},
    {"tool_input": {}},
    {"tool_input": {"command": ""}},
    {"tool_input": {"command": 42}},
    {"tool_input": "cat > f"},
])
def test_malformed_input_is_ignored(payload):
    assert run_hook(payload) == (0, None)


@pytest.mark.parametrize("raw", ["", "not json", "null", "[1, 2]"])
def test_unparseable_stdin_is_ignored(raw):
    assert run_hook(None, raw=raw) == (0, None)
