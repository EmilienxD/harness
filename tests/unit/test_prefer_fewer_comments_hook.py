"""Tests for the prefer-fewer-comments hook.

The hook is a standalone script inside the platform's `hooks/` directory, so
it's imported by path like the other harness hook tests. What's pinned down is
the detection: which added comments go over budget, which are left alone, that
strings are never mistaken for comments, and that every write path -- Claude's
edit tools, ChatGPT's apply_patch, a shell heredoc -- reaches the same scanner.
"""
import io
import json
import sys
from pathlib import Path

import pytest

HOOK_DIR = (
    Path(__file__).resolve().parents[2]
    / "harness" / "guards" / "prefer-fewer-comments"
)

sys.path.insert(0, str(HOOK_DIR))

import prefer_fewer_comments_hook as hook  # noqa: E402


@pytest.fixture(autouse=True)
def marker_dir(tmp_path, monkeypatch):
    """Keep each test's throttle state to itself."""
    monkeypatch.setattr(hook.tempfile, "gettempdir", lambda: str(tmp_path))
    return tmp_path


def run_hook(payload, raw=None, session="s1"):
    """Invoke main() with a stdin payload, returning (exit code, parsed stdout)."""
    if raw is None:
        payload = {"session_id": session, "hook_event_name": "PostToolUse", **payload}
    old_stdin, old_stdout = sys.stdin, sys.stdout
    captured = io.StringIO()
    sys.stdin = io.StringIO(raw if raw is not None else json.dumps(payload))
    sys.stdout = captured
    try:
        code = hook.main()
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
    out = captured.getvalue().strip()
    return code, json.loads(out) if out else None


def write(path, content, **extra):
    return {"tool_name": "Write", "tool_input": {"file_path": path, "content": content}, **extra}


def findings_for(path, text):
    family = hook.family_for(path)
    return hook.findings(text, hook.every_line(text), family, dict(hook.DEFAULT_LIMITS))


@pytest.mark.parametrize("explicit_workdir", [False, True])
def test_codex_session_limits_and_exemptions_use_tool_relative_paths(tmp_path, monkeypatch, explicit_workdir):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", [str(HOOK_DIR / "prefer_fewer_comments_hook.py"), "--chatgpt"])
    child = tmp_path / "child"
    child.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(child))
    policy = tmp_path / ".harness/guards/prefer-fewer-comments.toml"
    policy.parent.mkdir(parents=True)
    policy.write_text('version=1\n[limits]\nmax_comment_lines=0\n[[rules]]\npatterns=["child/exempt.py"]\nexempt=true\n')
    for filename, expected in [("target.py", True), ("exempt.py", False)]:
        event = write(filename, "# short\nvalue = 1\n", cwd=str(tmp_path if explicit_workdir else child))
        if explicit_workdir:
            event["tool_input"]["workdir"] = "child"
        code, output = run_hook(event, session=filename)
        assert code == 0
        assert (output is not None) is expected


def test_codex_comment_limits_do_not_search_ancestor_policy(tmp_path, monkeypatch):
    policy = tmp_path / ".harness/guards/prefer-fewer-comments.toml"
    policy.parent.mkdir(parents=True)
    policy.write_text('version=1\n[limits]\nmax_comment_lines=0\n')
    child = tmp_path / "child"
    child.mkdir()
    monkeypatch.chdir(child)
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setattr(sys, "argv", ["hook", "--chatgpt"])
    assert run_hook(write("a.py", "# short\nvalue = 1\n", cwd=str(child))) == (0, None)


def test_short_comment_is_within_budget():
    assert not findings_for("a.py", "# retry once: the API 502s on cold start\nrun()\n")


def test_long_comment_block_is_reported():
    text = (
        "# First we take the list of users.\n"
        "# Then we filter the inactive ones.\n"
        "# Then we sort them by name.\n"
        "# Finally we return the result.\n"
        "def f():\n"
        "    return 1\n"
    )
    found = findings_for("a.py", text)
    assert len(found) == 1


def test_one_very_long_comment_line_is_reported():
    text = "# " + "explanation " * 30 + "\nvalue = 1\n"
    assert findings_for("a.py", text)


def test_docstring_gets_a_larger_budget_than_a_comment():
    assert not findings_for("a.py", '"""One.\nTwo.\nThree."""\n')
    assert findings_for("a.py", "# One.\n# Two.\n# Three.\n")


def test_long_docstring_is_reported_as_a_docstring():
    text = "def f():\n    " + '"""' + "\n".join(f"line {n}" for n in range(8)) + '"""\n'
    assert findings_for("a.py", text)


def test_file_header_docstring_gets_its_own_budget():
    header = '"""' + "\n".join(f"line {n}" for n in range(8)) + '"""\nvalue = 1\n'
    assert not findings_for("a.py", header)
    # Even below a shebang and a licence comment, it is still the header.
    assert not findings_for("a.py", "#!/usr/bin/env python3\n" + header)
    essay = '"""' + "\n".join(f"line {n}" for n in range(20)) + '"""\nvalue = 1\n'
    assert findings_for("a.py", essay)


def test_string_containing_a_comment_marker_is_not_a_comment():
    text = 'url = "https://example.com/#anchor-that-is-long-enough-to-look-like-prose"\n'
    assert not findings_for("a.py", text)
    js = 'const s = "// not a comment, just text that runs on and on and on";\n'
    assert not findings_for("a.js", js)


def test_triple_quoted_value_is_not_a_docstring():
    text = 'QUERY = """\n' + "\n".join(f"select {n}" for n in range(10)) + '\n"""\n'
    assert not findings_for("a.py", text)


def test_c_style_block_and_doc_comments():
    block = "/*\n" + "\n".join(f" * note {n}" for n in range(6)) + "\n*/\nint x;\n"
    assert findings_for("a.c", block)
    doc = "let x = 1;\n/**\n" + "\n".join(f" * @param a{n}" for n in range(8)) + "\n*/\nfunction f() {}\n"
    assert findings_for("a.ts", doc)


def test_directives_and_shebangs_are_outside_the_budget():
    text = (
        "#!/usr/bin/env python3\n"
        "# -*- coding: utf-8 -*-\n"
        "# type: ignore\n"
        "# noqa: E501\n"
        "value = 1\n"
    )
    assert not findings_for("a.py", text)


def test_density_is_reported_for_a_comment_heavy_change():
    body = "".join(f"# step {n}\nvalue{n} = {n}\n" for n in range(12))
    assert findings_for("a.py", body)


def test_density_is_not_reported_for_a_small_change():
    body = "".join(f"# step {n}\nvalue{n} = {n}\n" for n in range(3))
    assert not findings_for("a.py", body)


def test_unknown_extension_is_skipped():
    assert hook.family_for("notes.unknownext") is None



def test_edit_only_reports_comments_the_edit_added():
    old = "# one\n# two\n# three\n# four\nvalue = 1\n"
    new = old + "other = 2\n"
    changes = hook.changes({
        "tool_name": "Edit",
        "tool_input": {"file_path": "a.py", "old_string": old, "new_string": new},
    })
    (path, text, added), = changes
    assert path == "a.py"
    assert not hook.findings(text, added, hook.PYTHON, dict(hook.DEFAULT_LIMITS))


def test_multiedit_reports_each_edit():
    changes = hook.changes({
        "tool_name": "MultiEdit",
        "tool_input": {
            "file_path": "a.py",
            "edits": [
                {"old_string": "a", "new_string": "# one\n# two\n# three\na"},
                {"old_string": "b", "new_string": "b"},
            ],
        },
    })
    assert len(changes) == 2


def test_apply_patch_reads_added_lines_only():
    patch = (
        "*** Begin Patch\n"
        "*** Update File: src/app.py\n"
        "@@\n"
        " def f():\n"
        "+    # we compute the total here\n"
        "+    # by summing the values\n"
        "+    # and then rounding it\n"
        "-    old = 1\n"
        "     return 2\n"
        "*** End Patch\n"
    )
    (path, text, added), = hook.changes({"tool_name": "apply_patch", "tool_input": {"command": patch}})
    assert path == "src/app.py"
    assert "old = 1" not in text
    assert hook.findings(text, added, hook.PYTHON, dict(hook.DEFAULT_LIMITS))


def test_heredoc_write_is_scanned_with_the_target_language():
    command = "cat > src/app.py <<'EOF'\n# one\n# two\n# three\nvalue = 1\nEOF\n"
    (path, text, added), = hook.changes({"tool_name": "Bash", "tool_input": {"command": command}})
    assert path == "src/app.py"
    assert hook.findings(text, added, hook.PYTHON, dict(hook.DEFAULT_LIMITS))


def test_cat_heredoc_piped_to_tee_is_scanned():
    command = "cat <<'EOF' | tee sample.py\n# one\n# two\n# three\n# four\n# five\nvalue = 1\nEOF"
    code, output = run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}, session="tee1")
    assert code == 0
    assert output is not None


def test_codex_apply_patch_event_delivers_a_finding():
    patch = "*** Begin Patch\n*** Add File: sample.py\n+# one\n+# two\n+# three\n+# four\n+# five\n+value = 1\n*** End Patch"
    code, output = run_hook({"tool_name": "apply_patch", "tool_input": {"command": patch}, "cwd": "."}, session="patch1")
    assert code == 0
    assert output is not None
    assert "5-line comment" in output["hookSpecificOutput"]["additionalContext"]


def test_powershell_set_content_is_scanned_after_the_write():
    command = "Set-Content -LiteralPath sample.py -Value @('# one','# two','# three','# four','# five','value = 1')"
    code, output = run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}, session="ps1")
    assert code == 0
    assert output is not None
    assert "5-line comment" in output["hookSpecificOutput"]["additionalContext"]


def test_printf_redirect_is_scanned_after_the_write():
    command = "printf '# one\\n# two\\n# three\\n# four\\n# five\\nvalue = 1\\n' > sample.py"
    code, output = run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}, session="printf1")
    assert code == 0
    assert output is not None


def test_power_shell_write_does_not_report_comment_syntax_in_a_string():
    command = "Set-Content -LiteralPath sample.py -Value @('url = \"https://example.com/#fragment\"', 'value = 1')"
    assert run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}, session="ps2") == (0, None)


def test_heredoc_without_a_file_target_is_ignored():
    assert not hook.changes({"tool_name": "Bash", "tool_input": {"command": "python <<'EOF'\n# a\nEOF\n"}})


def test_ordinary_shell_command_is_ignored():
    assert not hook.changes({"tool_name": "Bash", "tool_input": {"command": "git status # check"}})



def test_hook_emits_context_shape_for_an_over_budget_write():
    code, out = run_hook(write("a.py", "# one\n# two\n# three\nvalue = 1\n"))
    assert code == 0
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"


def test_hook_is_silent_when_the_write_is_within_budget():
    code, out = run_hook(write("a.py", "# retry once\nvalue = 1\n"))
    assert (code, out) == (0, None)


def test_hook_is_silent_on_malformed_input():
    assert run_hook(None, raw="{not json") == (0, None)
    assert run_hook(None, raw="[]") == (0, None)
    assert run_hook({"tool_name": "Write", "tool_input": None}) == (0, None)


def test_repeat_within_the_interval_is_throttled():
    body = "# one\n# two\n# three\nvalue = 1\n"
    first_code, first = run_hook(write("a.py", body))
    second_code, second = run_hook(write("a.py", body))
    assert first is not None and second is None
    assert (first_code, second_code) == (0, 0)


def test_rules_file_overrides_the_budget_and_exempts_paths(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    (tmp_path / ".harness" / "guards").mkdir(parents=True)
    (tmp_path / ".harness" / "guards" / hook.RULES_NAME).write_text(
        'version=1\n[limits]\nmax_comment_lines=5\n[[rules]]\npatterns=["docs/"]\nexempt=true\n',
        encoding="utf-8",
    )
    body = "# one\n# two\n# three\n# four\nvalue = 1\n"
    assert run_hook(write("a.py", body, cwd=str(tmp_path)))[1] is None
    long_body = "".join(f"# line {n}\n" for n in range(9)) + "value = 1\n"
    assert run_hook(write("docs/a.py", long_body, cwd=str(tmp_path)), session="s2")[1] is None
    assert run_hook(write("a.py", long_body, cwd=str(tmp_path)), session="s3")[1] is not None
