"""Regression tests for the /commit UserPromptSubmit hook's gitignore handling.

The hook parses the session transcript for the files Claude wrote and stages
exactly those. Files under a gitignored path (an agent-scratch dir like
`.issues-gateway/`, build output, ...) must be *reported* as skipped, never
staged -- otherwise `/commit --dry` claims it "Would stage" a file git then
refuses, and a real `/commit` whose only write is ignored dies on a spurious
`git add failed` (git add exits 1 on an ignored pathspec).

These run the hook's own helpers against a real throwaway repo, so they need
git on PATH (declared by the tool's `requires`).
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

HOOK = (
    Path(__file__).resolve().parent.parent
    / "harness" / "shipping" / "commit" / "shared" / "hooks" / "commit_core.py"
)
CLAUDE_ADAPTER = (
    Path(__file__).resolve().parent.parent
    / "harness" / "shipping" / "commit" / "claude" / "hooks" / "commit_UserPromptSubmit_hook.py"
)

sys.path.insert(0, str(HOOK.parent))
import commit_core as hook  # noqa: E402
sys.path.insert(0, str(CLAUDE_ADAPTER.parent))
import commit_UserPromptSubmit_hook as claude_adapter  # noqa: E402


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    (repo / "seed.md").write_text("seed\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    # The directory the agent scribbles in, and which the user gitignores.
    (repo / ".gitignore").write_text(".issues-gateway/\n")
    (repo / ".issues-gateway" / "abc").mkdir(parents=True)
    (repo / ".issues-gateway" / "abc" / "issue-0.md").write_text("draft\n")
    return repo


def _write_record(path):
    return {
        "type": "assistant",
        "cwd": str(path.parent),
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": f"id-{path.name}",
                    "name": "Write",
                    "input": {"file_path": str(path)},
                }
            ]
        },
    }


def _transcript(*paths):
    fh, name = __import__("tempfile").mkstemp(suffix=".jsonl")
    with os.fdopen(fh, "w", encoding="utf-8") as out:
        for p in paths:
            out.write(json.dumps(_write_record(Path(p))) + "\n")
    return name


def test_ignored_writes_are_not_staged_and_are_reported(repo):
    track = repo / "TEST.md"
    track.write_text("real change\n")
    ignored_existing = repo / ".issues-gateway" / "abc" / "issue-0.md"
    ignored_deleted = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(track, ignored_existing, ignored_deleted)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan is not None
    # Only the real (non-ignored) write survived the filter.
    assert scan.paths == [os.path.normpath(str(track))]
    # Both ignored paths are reported as skipped, not silently dropped.
    assert set(scan.ignored) == {
        os.path.normpath(str(ignored_existing)),
        os.path.normpath(str(ignored_deleted)),
    }

    # ... and the same filter is what a real /commit stages with.
    present, deletions, unmatched = hook.resolve_stage_set(scan.paths, str(repo))
    assert [os.path.basename(p) for p in present] == ["TEST.md"]
    assert deletions == [] and unmatched == []


def test_ignored_deleted_file_still_ignored_not_reported_missing(repo):
    """A gitignored write to a file that no longer exists must read as
    'gitignored', not as the baffling 'no longer exist' the bug produced."""
    gone = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(gone)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan.paths == []  # nothing left to stage
    assert scan.ignored == [os.path.normpath(str(gone))]
    # resolve_stage_set never even sees it.
    present, deletions, unmatched = hook.resolve_stage_set(scan.paths, str(repo))
    assert present == [] and deletions == [] and unmatched == []


def test_tracked_file_inside_ignored_dir_still_stages(repo):
    """gitignore ignores *untracked* files only; an ignored dir's tracked file
    Claude actually edited is a real change and must not be filtered out."""
    tracked_ignored = repo / ".issues-gateway" / "abc" / "issue-0.md"
    _git(repo, "add", "-f", ".issues-gateway/abc/issue-0.md")
    _git(repo, "commit", "-qm", "track it")
    tracked_ignored.write_text("edited\n")

    transcript = _transcript(tracked_ignored)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    assert scan.paths == [os.path.normpath(str(tracked_ignored))]
    assert scan.ignored == []


def test_only_ignored_writes_stage_nothing(repo):
    """The pre-fix failure: with nothing but an ignored write, `git add` was
    handed an ignored pathspec and exited 1, failing the whole commit."""
    gone = repo / ".issues-gateway" / "abc" / "gone.md"
    transcript = _transcript(gone)
    try:
        scan = hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)

    present, deletions, _ = hook.resolve_stage_set(scan.paths, str(repo))
    assert present + deletions == []
    # stage_paths on the filtered set is a no-op rather than an error.
    result, targets = hook.stage_paths(scan.paths, str(repo))
    assert result is None and targets == []
    assert _git(repo, "status", "--porcelain", "--", ".issues-gateway").strip() == ""


def test_unhandled_hook_exception_blocks_prompt_with_exit_2(monkeypatch, capsys):
    monkeypatch.setattr(
        claude_adapter,
        "main",
        lambda: (_ for _ in ()).throw(RuntimeError("thread failure")),
    )

    with pytest.raises(SystemExit) as stopped:
        claude_adapter.entrypoint()

    assert stopped.value.code == 2
    stderr = capsys.readouterr().err
    assert "harness commit hook failed in Claude Code" in stderr
    assert "RuntimeError: thread failure" in stderr


# --- files written by shell commands, not by Edit/Write --------------------


def _shell_record(command, cwd):
    return {
        "type": "assistant",
        "cwd": str(cwd),
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": f"id-sh-{abs(hash(command))}",
                    "name": "Bash",
                    "input": {"command": command},
                }
            ]
        },
    }


def _mixed_transcript(repo, *, tool_writes=(), commands=()):
    """A session that used Write for some files and the shell for others."""
    fh, name = __import__("tempfile").mkstemp(suffix=".jsonl")
    with os.fdopen(fh, "w", encoding="utf-8") as out:
        for p in tool_writes:
            out.write(json.dumps(_write_record(Path(p))) + "\n")
        for command in commands:
            out.write(json.dumps(_shell_record(command, repo)) + "\n")
    return name


def _scan(transcript, repo):
    try:
        return hook._scan_writes(transcript, str(repo))
    finally:
        os.unlink(transcript)


@pytest.mark.parametrize("command, filename", [
    ("cat > shell.md <<'EOF'\nwritten by heredoc\nEOF", "shell.md"),
    ("printf 'x\\n' >> shell.md", "shell.md"),
    ("sed -i 's/seed/x/' shell.md", "shell.md"),
    ("python3 - <<'PY'\nopen('shell.md', 'w').write('x')\nPY", "shell.md"),
    ("node -e \"require('fs').writeFileSync('shell.md','x')\"", "shell.md"),
    ("Set-Content -Path shell.md -Value 'x'", "shell.md"),
    ("cat in.txt | tee shell.md", "shell.md"),
])
def test_shell_written_files_are_staged(repo, command, filename):
    """The bug: a file Claude wrote through Bash never reached `git add`, so
    it silently missed the commit."""
    (repo / filename).write_text("shell change\n")
    scan = _scan(_mixed_transcript(repo, commands=[command]), repo)
    assert scan.paths == [os.path.normpath(str(repo / filename))]
    assert scan.unresolved == []


def test_mixed_session_stages_both_kinds_of_write(repo):
    """The case the fallback never covered: with at least one Edit/Write in
    the session there was a path list, so the shell-written file was dropped
    from it instead of triggering the stage-everything fallback."""
    tool_written = repo / "tool.md"
    tool_written.write_text("by Write\n")
    shell_written = repo / "shell.md"
    shell_written.write_text("by heredoc\n")

    transcript = _mixed_transcript(
        repo,
        tool_writes=[tool_written],
        commands=["cat > shell.md <<'EOF'\nby heredoc\nEOF"],
    )
    scan = _scan(transcript, repo)
    assert scan.paths == [
        os.path.normpath(str(tool_written)),
        os.path.normpath(str(shell_written)),
    ]

    result, targets = hook.stage_paths(scan.paths, str(repo))
    assert result.returncode == 0
    staged = _git(repo, "diff", "--cached", "--name-only").split()
    assert sorted(staged) == ["shell.md", "tool.md"]


def test_shell_deletion_is_staged_as_a_deletion(repo):
    """`rm` on a tracked file is a change to commit like any other."""
    (repo / "seed.md").unlink()
    scan = _scan(_mixed_transcript(repo, commands=["rm seed.md"]), repo)
    present, deletions, unmatched = hook.resolve_stage_set(scan.paths, str(repo))
    assert [os.path.basename(p) for p in deletions] == ["seed.md"]
    assert present == [] and unmatched == []


def test_read_only_commands_contribute_nothing(repo):
    commands = [
        "cat README.md",
        "sed -n '1,20p' seed.md",
        "grep -rn foo . 2>/dev/null",
        "ls -la > /dev/null",
        "git log --oneline | head -5",
    ]
    scan = _scan(_mixed_transcript(repo, commands=commands), repo)
    assert scan.paths == [] and scan.unresolved == []


@pytest.mark.parametrize("command", [
    "git apply fix.patch",
    "python3 - <<'PY'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nPY",
    "sed -i 's/a/b/' *.md",
    'echo hi > "$OUT"',
    "cd sub && sed -i 's/a/b/' f.txt",
])
def test_unreadable_shell_write_widens_to_staging_everything(repo, command):
    """A write we can see but can't name must not quietly commit a subset."""
    scan = _scan(_mixed_transcript(repo, commands=[command]), repo)
    assert scan.unresolved, command
    # Even with a perfectly good path list from other writes, the answer is
    # None -- which is what makes the caller run a plain `git add -A`.
    assert hook.changed_paths(scan) is None


def test_failed_shell_command_is_not_a_write(repo):
    """PostToolUse-style is_error records already filter tool writes; a failed
    heredoc must not widen the commit either."""
    transcript = _mixed_transcript(repo, commands=["git apply fix.patch"])
    with open(transcript, "a", encoding="utf-8") as out:
        out.write(json.dumps({
            "type": "user",
            "cwd": str(repo),
            "message": {"content": [{
                "type": "tool_result",
                "tool_use_id": f"id-sh-{abs(hash('git apply fix.patch'))}",
                "is_error": True,
            }]},
        }) + "\n")
    scan = _scan(transcript, repo)
    assert scan.unresolved == []


def test_heredoc_body_is_not_parsed_as_commands(repo):
    """A shell snippet inside a heredoc is the file's content, not something
    the session ran."""
    command = "cat > script.sh <<'EOF'\nrm -rf build\nmv a.md b.md\nEOF"
    scan = _scan(_mixed_transcript(repo, commands=[command]), repo)
    assert scan.paths == [os.path.normpath(str(repo / "script.sh"))]


def test_dry_run_reports_the_widening(repo):
    (repo / "TEST.md").write_text("x\n")
    scan = _scan(_mixed_transcript(repo, commands=["git apply fix.patch"]), repo)
    report = hook.build_dry_run_report(
        "msg", "sid", "", str(repo), scan, hook.Flags(dry=True, use_ai=False)
    )
    assert "could not be read" in report
    assert "Would stage all uncommitted changes in the repo." in report


def test_dry_run_widening_still_lists_known_tool_writes(repo):
    """The false-positive for-loop case: an unparseable shell write in the
    session is reported as the widen reason, but the Edit/Write paths the
    session *did* identify must still appear in the report -- otherwise the
    user sees 'would stage everything' and concludes their edits were lost.
    """
    tool_written = repo / "tool.md"
    tool_written.write_text("x\n")

    # A for-loop whose in-place edit's target is held in a variable. The
    # hook correctly flags it as a write with an unreadable target.
    loop_cmd = (
        'for f in a b c; do\n'
        '  sed -i s/x/y/ "$f"\n'
        'done'
    )
    transcript = _mixed_transcript(
        repo, tool_writes=[tool_written], commands=[loop_cmd]
    )
    scan = _scan(transcript, repo)
    assert scan.unresolved  # the trigger
    assert scan.paths == [os.path.normpath(str(tool_written))]

    report = hook.build_dry_run_report(
        "msg", "sid", "", str(repo), scan, hook.Flags(dry=True, use_ai=False)
    )
    assert "could not be read" in report
    assert "Would stage all uncommitted changes in the repo." in report
    # But the known write is *named*, not silently dropped from the report.
    assert "tool.md" in report
    assert "Tool writes already identified" in report
    # And the trailing status block runs (widened case shows the whole tree).
    assert "Changes to commit:" in report


def test_dry_run_transcript_unreadable_does_not_duplicate_status(repo):
    """When the transcript can't be read at all the fall-back branch already
    prints the whole-repo status inline; a second 'Changes to commit' block
    below repeats it verbatim and reads as a bug."""
    (repo / "TEST.md").write_text("x\n")
    report = hook.build_dry_run_report(
        "msg", "sid", "", str(repo), None, hook.Flags(dry=True, use_ai=False)
    )
    assert "Would stage all uncommitted changes in the repo:" in report
    # The inline status block, not the trailing one.
    assert "Changes to commit:" not in report


def _mock_ai_inputs(monkeypatch):
    monkeypatch.setattr(hook, "find_api_key", lambda _repo: ("test-secret", "$TEST"))
    monkeypatch.setattr(
        hook,
        "_build_prompt",
        lambda *_args: ("the prompt", {"diff_chars": 10, "files": 1}),
    )


def test_generate_commit_message_calls_gemini_rest_api(monkeypatch):
    _mock_ai_inputs(monkeypatch)
    captured = {}
    response = {
        "candidates": [{
            "content": {"parts": [{"text": json.dumps({
                "reasoning": "Matches the repository style.",
                "subject": "add stdlib Gemini transport",
                "body": "Avoid requiring a separately installed SDK.",
            })}]},
            "finishReason": "STOP",
        }]
    }

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return io.BytesIO(json.dumps(response).encode())

    monkeypatch.setattr(hook.urllib.request, "urlopen", fake_urlopen)

    message = hook.generate_commit_message("repo", [], True, "", "")

    request = captured["request"]
    payload = json.loads(request.data)
    assert request.method == "POST"
    assert request.full_url == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{hook.AI_MODEL}:generateContent"
    )
    assert request.get_header("X-goog-api-key") == "test-secret"
    assert request.get_header("Content-type") == "application/json"
    assert captured["timeout"] == 45
    assert payload["contents"] == [{"parts": [{"text": "the prompt"}]}]
    assert payload["systemInstruction"]["parts"][0]["text"] == hook.SYSTEM_INSTRUCTION
    config = payload["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert config["responseSchema"]["required"] == ["reasoning", "subject"]
    assert message.subject == "add stdlib Gemini transport"
    assert message.body == "Avoid requiring a separately installed SDK."
    assert message.model == hook.AI_MODEL


def test_generate_commit_message_uses_configured_base_url(monkeypatch):
    _mock_ai_inputs(monkeypatch)
    monkeypatch.setattr(hook, "GEMINI_BASE_URL", "https://gateway.example")
    captured = {}
    response = {
        "candidates": [{"content": {"parts": [{"text": json.dumps({
            "reasoning": "Uses the configured gateway.",
            "subject": "route Gemini through gateway",
        })}]}}]
    }

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        return io.BytesIO(json.dumps(response).encode())

    monkeypatch.setattr(hook.urllib.request, "urlopen", fake_urlopen)

    hook.generate_commit_message("repo", [], True, "", "")

    assert captured["url"] == (
        f"https://gateway.example/v1beta/models/{hook.AI_MODEL}:generateContent"
    )


def test_configured_base_url_strips_trailing_slashes(monkeypatch):
    monkeypatch.setenv("COMMIT_AI_BASE_URL", "https://gateway.example/v1beta///")

    spec = importlib.util.spec_from_file_location("commit_hook_base_url_test", HOOK)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)

    assert loaded.GEMINI_BASE_URL == "https://gateway.example/v1beta"


def test_generate_commit_message_surfaces_gemini_http_error(monkeypatch):
    _mock_ai_inputs(monkeypatch)
    error_body = io.BytesIO(json.dumps({
        "error": {"message": "API key not valid. Please pass a valid API key."}
    }).encode())

    def fake_urlopen(_request, timeout):
        assert timeout == hook.AI_TIMEOUT_SECONDS
        raise urllib.error.HTTPError(
            "https://example.invalid", 400, "Bad Request", {}, error_body
        )

    monkeypatch.setattr(hook.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(hook.AiError, match="HTTP 400: API key not valid"):
        hook.generate_commit_message("repo", [], True, "", "")


def test_generate_commit_message_reports_finish_reason_without_text(monkeypatch):
    _mock_ai_inputs(monkeypatch)
    response = {
        "candidates": [{"content": {"parts": []}, "finishReason": "SAFETY"}]
    }
    monkeypatch.setattr(
        hook.urllib.request,
        "urlopen",
        lambda _request, timeout: io.BytesIO(json.dumps(response).encode()),
    )

    with pytest.raises(hook.AiError, match=r"finish_reason=SAFETY"):
        hook.generate_commit_message("repo", [], True, "", "")
