"""Tests for the issue-writers drafting and publishing pipeline.

The tool has one job: the agent writes Markdown drafts into
`.harness/issue-drafts/<session-id>.issue-<i>.md`, and `/publish-issues` turns
them into real GitHub issues. Drafts are flat files rather than per-session
folders, so no session owns a container another session could remove.
Everything the tool remembers between runs lives either in the drafts
themselves or outside the repository, so a working tree only ever holds drafts
and a `.gitignore`.

Tests here exercise the public seams: the publish command surface, the
drafting context handed to skills, the draft format the SKILL.md files
document, the argv handed to `gh`, and the hook as a process.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

CORE = (
    Path(__file__).resolve().parents[2]
    / "harness" / "building" / "issue-writers" / "issues_core.py"
)
CLAUDE_ADAPTER = CORE.parent / "issue_writers_hook.py"

sys.path.insert(0, str(CORE.parent))
import issues_core as hook  # noqa: E402

SID = "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55"
OTHER_SID = "11111111-2222-4333-8444-555555555555"


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    """Keep every test's lock and notice inside its own tmp_path."""
    monkeypatch.setenv(hook.STATE_DIR_VARIABLE, str(tmp_path / "state"))


def _draft(root: Path, name: str, text: str, session: str = SID) -> Path:
    """Write one draft. `name` is the "issue-{i}.md" half of the filename."""
    drafts = root / ".harness" / "issue-drafts"
    drafts.mkdir(parents=True, exist_ok=True)
    path = drafts / f"{session}.{name}"
    path.write_text(text, encoding="utf-8")
    return path


def _capture_creates(monkeypatch, urls):
    """Record what reaches gh_create_issue and hand back canned URLs."""
    calls = []

    def fake_create(title, body, labels, parent=None):
        calls.append(
            {"title": title, "body": body, "labels": labels, "parent": parent}
        )
        if len(calls) > len(urls):
            return False, "no more canned URLs"
        return True, urls[len(calls) - 1]

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    return calls


# The out-of-repo store


def test_lock_and_notice_live_outside_the_repository(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    lock = hook.lock_path(tmp_path)
    notice = hook.notice_path(tmp_path, SID)

    assert hook.DRAFTS_DIR.name not in lock.parts
    assert lock.parent == hook.store_dir()
    assert lock.suffix == ".lock"
    assert notice.name.endswith(".notice.json")
    assert SID in notice.name
    # Two sessions in one repository never share a notice.
    assert hook.notice_path(tmp_path, OTHER_SID) != notice
    # Two repositories never share a lock.
    assert hook.lock_path(tmp_path / "elsewhere") != lock


def test_state_directory_variable_overrides_the_default_home(tmp_path, monkeypatch):
    monkeypatch.setenv(hook.STATE_DIR_VARIABLE, str(tmp_path / "custom"))
    assert (tmp_path / "custom") in hook.lock_path(tmp_path).parents


def test_successful_publish_leaves_only_drafts_and_gitignore_in_the_repo(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")
    drafts = draft.parent
    (drafts / ".gitignore").write_text("*\n", encoding="utf-8")

    result = hook.publish_issues(False, SID)

    assert "Published 1 issue(s) successfully" in result
    assert {path.name for path in drafts.iterdir()} == {".gitignore"}


# Crash recovery: the draft's own filename is the only record


def test_draft_is_renamed_across_the_create_and_removed_on_success(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")
    seen = {}

    def fake_create(title, body, labels, parent=None):
        # Mid-create the draft must already be claimed, so a crash here is
        # distinguishable from a draft that never started publishing.
        seen["claimed"] = (draft.parent / (draft.name + hook.PUBLISHING_SUFFIX)).exists()
        seen["original"] = draft.exists()
        return True, "https://github.com/x/y/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])

    hook.publish_issues(False, SID)

    assert seen == {"claimed": True, "original": False}
    assert not draft.exists()


def test_failed_create_restores_the_draft_for_a_rerun(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    monkeypatch.setattr(
        hook, "gh_create_issue", lambda *a, **k: (False, "GitHub unavailable")
    )
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert "1 failed or were skipped" in result
    assert draft.exists()
    assert not (draft.parent / (draft.name + hook.PUBLISHING_SUFFIX)).exists()


def _interrupted(root: Path, name: str, text: str) -> Path:
    return _draft(root, name + hook.PUBLISHING_SUFFIX, text)


def test_interrupted_draft_whose_issue_exists_is_discarded_not_republished(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, [])
    monkeypatch.setattr(
        hook,
        "gh_find_issues_by_title",
        lambda title: (True, [{"number": 42, "title": title, "url": "u"}]),
    )
    stale = _interrupted(tmp_path, "issue-0.md", "# Crashed\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert created == []
    assert not stale.exists()
    assert "already published as #42" in result


def test_interrupted_draft_that_never_reached_github_is_published(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/7"])
    monkeypatch.setattr(hook, "gh_find_issues_by_title", lambda title: (True, []))
    stale = _interrupted(tmp_path, "issue-0.md", "# Crashed\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert [entry["title"] for entry in created] == ["Crashed"]
    assert not stale.exists()
    assert "Published 1 issue(s) successfully" in result


def test_ambiguous_interrupted_draft_is_left_for_the_user(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, [])
    monkeypatch.setattr(
        hook,
        "gh_find_issues_by_title",
        lambda title: (True, [{"number": 1}, {"number": 2}]),
    )
    stale = _interrupted(tmp_path, "issue-0.md", "# Crashed\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert created == []
    assert stale.exists()
    assert "several issues share the title" in result


def test_recovered_number_resolves_references_from_other_drafts(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    monkeypatch.setattr(
        hook,
        "gh_find_issues_by_title",
        lambda title: (True, [{"number": 42, "title": title, "url": "u"}]),
    )
    _interrupted(tmp_path, "issue-0.md", "# Crashed\n\n> mode:afk\n\nbody\n")
    _draft(
        tmp_path,
        "issue-1.md",
        f"# Child\n\n> mode:afk\n\n## Blocked by\n\n{SID}/0\n",
    )

    hook.publish_issues(False, SID)

    assert "#42" in created[0]["body"]


# The draft format the SKILL.md files document


def _labels(body: str):
    """extract_labels over a full draft body (title already stripped)."""
    return hook.extract_labels(body)


def test_both_labels_any_order():
    labels, body = _labels("> difficulty:advanced, mode:hitl\n\n## What\n")
    assert labels == ["[AI]-advanced-difficulty", "[AI]-hitl"]
    assert body == "## What"
    labels, _ = _labels("> mode:afk, difficulty:expert\n\nbody")
    assert labels == ["[AI]-afk", "[AI]-expert-difficulty"]


def test_only_one_of_each_pair():
    labels, _ = _labels("> difficulty:basic\n\nbody")
    assert labels == ["[AI]-basic-difficulty"]
    labels, _ = _labels("> mode:afk\n\nbody")
    assert labels == ["[AI]-afk"]


def test_extra_labels_pass_through_asis():
    labels, _ = _labels("> ci\n\nbody")
    assert labels == ["ci"]
    labels, _ = _labels("> ci, mode:hitl\n\nbody")
    assert labels == ["ci", "[AI]-hitl"]
    labels, _ = _labels("> good-first-issue, difficulty:routine\n\nbody")
    assert labels == ["good-first-issue", "[AI]-routine-difficulty"]


def test_spec_line_maps_to_canonical_label():
    labels, body = _labels("> spec\n\n## Problem\n")
    assert labels == ["[AI]-spec"]
    assert body == "## Problem"


def test_chrome_line_maps_to_canonical_label():
    labels, body = _labels(
        "> difficulty:advanced, mode:hitl, chrome\n\n## What\n"
    )
    assert labels == [
        "[AI]-advanced-difficulty",
        "[AI]-hitl",
        "[AI]-chrome",
    ]
    assert body == "## What"


def test_spec_with_extra_labels():
    # A spec declares labels like any other issue: "spec" is one token on
    # the list, everything else rides alongside it.
    labels, body = _labels("> spec, security\n\n## Problem\n")
    assert labels == ["[AI]-spec", "security"]
    assert body == "## Problem"
    labels, _ = _labels("> spec, good first issue, mode:hitl\n\nbody")
    assert labels == ["[AI]-spec", "good first issue", "[AI]-hitl"]


def test_multiword_extra_labels_parse():
    labels, _ = _labels("> good first issue\n\nbody")
    assert labels == ["good first issue"]
    labels, _ = _labels("> good first issue, difficulty:basic\n\nbody")
    assert labels == ["good first issue", "[AI]-basic-difficulty"]


def test_whitespace_and_case_tolerance():
    labels, _ = _labels("  > Difficulty:Advanced , MODE:hitl \n\nbody")
    assert labels == ["[AI]-advanced-difficulty", "[AI]-hitl"]


def test_blank_lines_before_label_line_are_skipped():
    labels, _ = _labels("\n\n> mode:afk\n\nbody")
    assert labels == ["[AI]-afk"]


def test_malformed_lines_yield_no_labels_and_keep_body():
    # A ">" line that isn't a clean label list is left in the body, so it
    # gets skipped instead of being published with silently-partial labels.
    for bad in [
        "> ci, mode:",            # second token isn't a label
        "> mode:hitl, ",          # trailing comma / empty token
        "> # comment",            # header-ish
    ]:
        labels, body = _labels(f"{bad}\n\nrest\n")
        assert labels == [], bad
        assert body.startswith(bad), bad


def test_unknown_difficulty_value_is_treated_as_extra_label():
    # "difficulty:extreme" isn't an alias; it passes through verbatim so a
    # dry run shows it and a real publish lets gh be the authority.
    labels, _ = _labels("> difficulty:advanced, difficulty:extreme\n\nbody")
    assert labels == ["[AI]-advanced-difficulty", "difficulty:extreme"]


def test_duplicate_tokens_dedupe():
    labels, _ = _labels("> mode:afk, mode:afk\n\nbody")
    assert labels == ["[AI]-afk"]


def test_missing_label_line_means_no_labels():
    labels, body = _labels("## What to build\n\neverything\n")
    assert labels == []
    assert body.startswith("## What")


def test_ensure_labels_creates_missing_and_leaves_existing_alone(tmp_path, monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        name = args[3]
        # One label already exists in the repo.
        if name == "[AI]-spec":
            return type(
                "R", (), {"returncode": 1, "stderr": "label already exists", "stdout": ""}
            )()
        return type("R", (), {"returncode": 0, "stderr": "", "stdout": "created"})()

    monkeypatch.setattr(hook.subprocess, "run", fake_run)
    warnings = hook.ensure_labels(dry=False)

    assert warnings == []
    assert all("--force" not in c for c in calls)
    assert len(calls) == len(hook.CANONICAL_LABELS)


def test_references_are_plain_text_and_resolve_to_bare_numbers():
    # In-file references are "session-id/{i}" as plain text - no backticks,
    # no braces - and resolve to a bare "#n", because GitHub only autolinks
    # issue numbers that aren't inside inline code.
    body = f"Blocked by {SID}/0\nSee also {SID}/0 and {SID}/1"
    resolved, unresolved = hook.resolve_references(body, {f"{SID}/0": "42"})
    assert "Blocked by #42" in resolved
    assert resolved.count("#42") == 2
    assert unresolved == [f"{SID}/1"]


def test_prompt_pattern_matches_with_or_without_dry():
    assert hook.PROMPT_PATTERN.search("/publish-issues")
    assert hook.PROMPT_PATTERN.search("/publish-issue")
    assert hook.PROMPT_PATTERN.search("/publish-issues --dry")
    assert not hook.PROMPT_PATTERN.search("/publish-issuesx")
    assert hook.PROMPT_PATTERN.search("hello /publish-issues")


def test_parent_section_accepts_every_reference_form():
    for text, expected in [
        ("#42", "42"),
        ("42", "42"),
        ("https://github.com/o/r/issues/42", "42"),
        (f"{SID}/0", f"{SID}/0"),
    ]:
        ref, body = hook.extract_parent(f"## Parent\n\n{text}\n\n## What\n\nx")
        assert ref == expected, text
        # Consumed: GitHub renders the parent itself, so it leaves the body.
        assert "## Parent" not in body, text
        assert body == "## What\n\nx", text


def test_parent_prose_is_left_exactly_as_written():
    # The template's own placeholder must not be mistaken for a link.
    original = (
        "## Parent\n\nA reference to the parent issue on the issue tracker.\n\n"
        "## What\n\nx"
    )
    assert hook.extract_parent(original) == (None, original)


def test_parent_none_is_an_explicit_opt_out():
    ref, body = hook.extract_parent("## Parent\n\nNone\n\n## What\n\nx")
    assert ref is None
    assert body == "## What\n\nx"


def test_parent_section_may_be_last_in_the_body():
    ref, body = hook.extract_parent("## What\n\nx\n\n## Parent\n\n#7\n")
    assert ref == "7"
    assert body == "## What\n\nx"


def test_no_parent_section_changes_nothing():
    original = "## What\n\nx"
    assert hook.extract_parent(original) == (None, original)


def test_resolve_parent_direct_and_session_references():
    assert hook.resolve_parent("42", {}) == ("42", False)
    assert hook.resolve_parent(f"{SID}/0", {f"{SID}/0": "7"}) == ("7", False)
    # Not yet published: retryable, because it may come later in this run.
    assert hook.resolve_parent(f"{SID}/0", {}) == (None, True)


def _fake_gh(monkeypatch, calls, help_text="", returncode=0, stdout=""):
    issue = {}

    def fake_run(args, **kwargs):
        calls.append(args)
        if args[:4] == ["gh", "issue", "create", "--help"]:
            return type("R", (), {"returncode": 0, "stdout": help_text, "stderr": ""})()
        if args[:3] == ["gh", "issue", "create"]:
            issue.update(title=args[args.index("--title") + 1], body=Path(args[args.index("--body-file") + 1]).read_text(encoding="utf-8"))
        if args[:3] == ["gh", "issue", "view"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(issue), "")
        return type("R", (), {"returncode": returncode, "stdout": stdout, "stderr": ""})()

    monkeypatch.setattr(hook.subprocess, "run", fake_run)


def test_parent_flag_is_detected_once_from_gh_help(monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "_parent_flag_supported", None)
    _fake_gh(monkeypatch, calls, help_text="  --parent number  Add as a sub-issue")
    assert hook.parent_flag_supported() is True
    assert hook.parent_flag_supported() is True
    assert len(calls) == 1  # probed once per run, not once per issue

    monkeypatch.setattr(hook, "_parent_flag_supported", None)
    calls.clear()
    _fake_gh(monkeypatch, calls, help_text="  --label name  Add labels")
    assert hook.parent_flag_supported() is False


def test_gh_create_issue_uses_body_file_and_passes_parent(monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "_parent_flag_supported", True)
    _fake_gh(monkeypatch, calls, stdout="https://github.com/x/y/issues/43\n")

    ok, url = hook.gh_create_issue("T", "body", ["[AI]-afk"], "42")

    assert (ok, url) == (True, "https://github.com/x/y/issues/43")
    args = calls[0]
    assert args[:3] == ["gh", "issue", "create"]
    assert "--parent" in args and args[args.index("--parent") + 1] == "42"
    # The body never goes on the command line - that is the Windows fix.
    assert "--body-file" in args and "--body" not in args
    assert "body" not in args


def test_gh_create_issue_omits_parent_when_there_is_none(monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "_parent_flag_supported", True)
    _fake_gh(monkeypatch, calls, stdout="https://github.com/x/y/issues/43\n")

    hook.gh_create_issue("T", "body", ["[AI]-afk"])
    assert "--parent" not in calls[0]


def test_chunker_prefers_paragraph_then_line_boundaries():
    body = "first paragraph\n\nsecond paragraph\nlast line"
    chunks = hook.chunk_markdown(body, 18)
    assert chunks[0] == "first paragraph\n\n"

    chunks = hook.chunk_markdown("first line\nsecond-line-is-long", 15)
    assert chunks[0] == "first line\n"


def _rendered_content(part: str) -> str:
    """Strip the generated heading a rendered part carries."""
    return part.split("\n\n", 1)[1]


def test_chunker_closes_and_reopens_an_unavoidably_split_fence():
    body = "```python\n" + ("print('x')\n" * 10_000) + "```"
    parts = hook.render_parts(body)
    contents = [_rendered_content(part) for part in parts]
    assert contents[0].endswith("```")
    assert contents[1].startswith("```python\n")
    repaired = "\n".join(contents).replace("\n```\n```python\n", "\n", 1)
    assert repaired == body


def test_comment_body_file_uses_lf_newlines(monkeypatch):
    captured = []

    def fake_run(args, **kwargs):
        path = Path(args[args.index("--body-file") + 1])
        captured.append((args, path.read_bytes()))
        return type("R", (), {"returncode": 0, "stdout": "ok", "stderr": ""})()

    monkeypatch.setattr(hook.subprocess, "run", fake_run)
    assert hook.gh_comment_issue("https://github.com/x/y/issues/42", "a\nb\n")[0]
    args, payload = captured[0]
    assert args[:4] == ["gh", "issue", "comment", "https://github.com/x/y/issues/42"]
    assert payload == b"a\nb\n"


# The pending notice: the only way a hook-run publish reaches the agent


def test_notice_is_delivered_once_then_gone(tmp_path):
    hook.queue_notice(
        tmp_path, SID, [{"number": "42", "title": "Spec", "labels": ["[AI]-spec"]}], 0
    )

    first = hook.flush_notice(tmp_path, SID)

    assert "#42" in first and "Spec" in first
    assert hook.flush_notice(tmp_path, SID) is None
    assert not hook.notice_path(tmp_path, SID).exists()


def test_notice_accumulates_across_consecutive_publish_runs(tmp_path):
    hook.queue_notice(tmp_path, SID, [{"number": "1", "title": "A", "labels": []}], 0)
    hook.queue_notice(tmp_path, SID, [{"number": "2", "title": "B", "labels": []}], 1)

    notice = hook.flush_notice(tmp_path, SID)

    assert "#1" in notice and "#2" in notice
    assert "1 draft(s) failed" in notice


def test_one_session_never_reads_another_sessions_notice(tmp_path):
    hook.queue_notice(
        tmp_path, SID, [{"number": "42", "title": "Mine", "labels": []}], 0
    )

    assert hook.flush_notice(tmp_path, OTHER_SID) is None
    assert "Mine" in hook.flush_notice(tmp_path, SID)


def test_nothing_published_queues_no_notice(tmp_path):
    hook.queue_notice(tmp_path, SID, [], 0)
    assert not hook.notice_path(tmp_path, SID).exists()
    assert hook.flush_notice(tmp_path, SID) is None


def test_corrupt_notice_is_dropped_not_raised(tmp_path):
    path = hook.notice_path(tmp_path, SID)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")

    assert hook.flush_notice(tmp_path, SID) is None


def test_notice_stays_under_the_additional_context_cap(tmp_path):
    hook.queue_notice(
        tmp_path,
        SID,
        [
            {"number": str(n), "title": "T" * 60, "labels": ["[AI]-afk"]}
            for n in range(500)
        ],
        0,
    )

    notice = hook.flush_notice(tmp_path, SID)

    assert len(notice) < 10_000
    assert "and 450 more" in notice


# Automatic cleanup: no command to learn


def test_idle_drafts_are_swept_after_a_week(tmp_path):
    stale = _draft(tmp_path, "issue-0.md", "# Old\n", session=OTHER_SID)
    fresh = _draft(tmp_path, "issue-0.md", "# New\n")
    old = time.time() - hook.SESSION_MAX_AGE - 60
    os.utime(stale, (old, old))

    hook.sweep_stale(tmp_path)

    # Each draft's own mtime decides its fate, so a session that is still
    # drafting cannot be swept along with an abandoned neighbour.
    assert not stale.exists()
    assert fresh.exists()


def test_undelivered_notices_are_swept_after_a_week(tmp_path):
    hook.queue_notice(tmp_path, SID, [{"number": "1", "title": "A", "labels": []}], 0)
    path = hook.notice_path(tmp_path, SID)
    old = time.time() - hook.SESSION_MAX_AGE - 60
    os.utime(path, (old, old))

    hook.sweep_stale(tmp_path)

    assert not path.exists()


def test_sweep_never_deletes_a_file_the_tool_did_not_write(tmp_path):
    draft = _draft(tmp_path, "issue-0.md", "# Recent\n")
    stray = draft.parent / "notes.md"
    stray.write_text("a user's own file\n", encoding="utf-8")
    old = time.time() - hook.SESSION_MAX_AGE - 60
    os.utime(stray, (old, old))

    hook.sweep_stale(tmp_path)

    assert draft.exists()
    assert stray.exists()


# The command surface is exactly /publish-issues and --dry


@pytest.mark.parametrize(
    "prompt",
    [
        "/publish-issues --gc",
        "/publish-issues --discard-current",
        "/publish-issues --older-than 30d",
        "/publish-issues --nonsense",
    ],
)
def test_removed_and_unknown_options_are_rejected(prompt, tmp_path):
    result = hook.run_publish_command(prompt, SID, tmp_path)
    assert "Invalid publish command" in result
    assert "/publish-issues --dry" in result


def test_dry_run_reports_each_draft_and_touches_nothing(tmp_path, monkeypatch):
    def explode(*args, **kwargs):
        raise AssertionError("a dry run must never invoke gh")

    monkeypatch.setattr(hook, "run_gh", explode)
    draft = _draft(
        tmp_path, "issue-0.md", "# T\n\n> difficulty:basic, mode:afk\n\nbody\n"
    )

    result = hook.run_publish_command("/publish-issues --dry", SID, tmp_path)

    assert 'Would create: "T" [[AI]-basic-difficulty, [AI]-afk]' in result
    assert "1 issue(s) ready to publish" in result
    assert draft.exists()
    assert not hook.notice_path(tmp_path, SID).exists()


# Oversized bodies still publish as issue + continuation comments


def _oversized_body() -> str:
    return "\n\n".join(f"Paragraph {n}. " + "x" * 200 for n in range(600))


def test_oversized_body_posts_continuation_comments(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    comments = []

    def fake_comment(url, body):
        comments.append((url, body))
        return True, ""

    monkeypatch.setattr(hook, "gh_comment_issue", fake_comment)
    body = _oversized_body()
    _draft(tmp_path, "issue-0.md", f"# Big\n\n> mode:afk\n\n{body}\n")

    result = hook.publish_issues(False, SID)

    assert "Published 1 issue(s) successfully" in result
    assert len(comments) >= 1
    assert created[0]["body"].startswith("> **Part 1 of ")
    assert all(len(payload) <= hook.GITHUB_BODY_LIMIT for _, payload in comments)
    rebuilt = "".join(
        part.split("\n\n", 1)[1]
        for part in [created[0]["body"], *(payload for _, payload in comments)]
    )
    assert rebuilt.strip() == body.strip()


def test_failed_continuation_reports_the_gap_and_still_names_the_issue(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    monkeypatch.setattr(hook, "gh_comment_issue", lambda url, body: (False, "boom"))
    _draft(tmp_path, "issue-0.md", f"# Big\n\n> mode:afk\n\n{_oversized_body()}\n")

    result = hook.publish_issues(False, SID)

    assert "continuation part 2 of" in result
    assert "https://github.com/x/y/issues/42 exists" in result
    # The agent still has to learn the number of an issue that does exist.
    assert "#42" in hook.flush_notice(tmp_path, SID)


# Ordering, references and parents across a whole batch


def test_blocker_reference_resolves_within_one_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(
        monkeypatch,
        ["https://github.com/x/y/issues/42", "https://github.com/x/y/issues/43"],
    )
    _draft(tmp_path, "issue-0.md", "# Base\n\n> mode:afk\n\nbody\n")
    _draft(
        tmp_path,
        "issue-1.md",
        f"# Dependent\n\n> mode:afk\n\n## Blocked by\n\n{SID}/0\n",
    )

    hook.publish_issues(False, SID)

    assert "#42" in created[1]["body"]
    assert f"{SID}/0" not in created[1]["body"]


def test_out_of_order_dependency_self_heals_in_one_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(
        monkeypatch,
        ["https://github.com/x/y/issues/42", "https://github.com/x/y/issues/43"],
    )
    # issue-0 depends on issue-1: the wrong order for a single pass.
    _draft(
        tmp_path,
        "issue-0.md",
        f"# First\n\n> mode:afk\n\n## Blocked by\n\n{SID}/1\n",
    )
    _draft(tmp_path, "issue-1.md", "# Second\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert "Published 2 issue(s) successfully" in result
    assert [entry["title"] for entry in created] == ["Second", "First"]
    assert "#42" in created[1]["body"]


def test_failed_draft_keeps_resolved_numbers_for_the_next_run(tmp_path, monkeypatch):
    """The drafts on disk are the only cross-run memory there is."""
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# Base\n\n> mode:afk\n\nbody\n")
    # No label line, so this one can never publish and stays behind.
    broken = _draft(tmp_path, "issue-1.md", f"# Broken\n\nblocked by {SID}/0\n")

    hook.publish_issues(False, SID)

    assert "#42" in broken.read_text(encoding="utf-8")
    assert f"{SID}/0" not in broken.read_text(encoding="utf-8")


def test_declared_parent_reaches_gh_and_is_stripped_from_the_body(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(
        tmp_path,
        "issue-0.md",
        "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n\n## What\n\nbody\n",
    )

    hook.publish_issues(False, SID)

    assert created[0]["parent"] == "42"
    assert "## Parent" not in created[0]["body"]
    assert "## What" in created[0]["body"]


def test_old_gh_links_the_parent_after_creating_and_keeps_the_reference(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: False)
    links = []

    def fake_link(child, parent):
        links.append((child, parent))
        return True, ""

    monkeypatch.setattr(hook, "gh_link_parent", fake_link)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(tmp_path, "issue-0.md", "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n")

    hook.publish_issues(False, SID)

    assert links == [("43", "42")]
    # The reference stays visible in the body, because the follow-up link is
    # a second call that can still fail.
    assert "## Parent" in created[0]["body"]
    assert "#42" in created[0]["body"]


def test_unresolvable_reference_leaves_the_draft_and_reports_it(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, [])
    draft = _draft(
        tmp_path,
        "issue-0.md",
        f"# Orphan\n\n> mode:afk\n\n## Blocked by\n\n{OTHER_SID}/9\n",
    )

    result = hook.publish_issues(False, SID)

    assert "unresolved reference" in result
    assert draft.exists()


def test_draft_without_a_label_line_is_skipped_and_kept(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, [])
    draft = _draft(tmp_path, "issue-0.md", "# No labels\n\n## What\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert "missing or malformed label line" in result
    assert draft.exists()


def test_publish_only_touches_the_current_session(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# Current\n\n> mode:afk\n\nbody\n")
    other = _draft(tmp_path, "issue-0.md", "# Other\n\n> mode:afk\n\nbody\n", OTHER_SID)

    hook.publish_issues(False, SID)

    assert [entry["title"] for entry in created] == ["Current"]
    assert other.exists()


def test_a_second_publisher_is_turned_away_rather_than_racing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")

    with hook.file_lock(hook.lock_path(tmp_path)) as acquired:
        assert acquired
        result = hook.publish_issues(False, SID)

    assert "Another publish is already running" in result


# Drafting context


def test_draft_store_allocates_a_full_session_scoped_path(tmp_path):
    assert hook.next_draft_path(tmp_path, SID) == hook.DRAFTS_DIR / f"{SID}.issue-0.md"


def test_the_ignore_file_covers_drafts_without_ignoring_harness_config(tmp_path):
    # .harness/ also holds guard policies and launcher config the user commits
    # on purpose, so the "*" must never sit at the .harness/ level.
    hook.prepare_drafting_context(tmp_path, SID)

    assert (tmp_path / ".harness/issue-drafts/.gitignore").read_text() == "*\n"
    assert not (tmp_path / ".harness/.gitignore").exists()


def test_drafting_context_counts_existing_drafts(tmp_path):
    _draft(tmp_path, "issue-0.md", "# A\n")
    _draft(tmp_path, "issue-1.md", "# B\n")

    assert hook.next_draft_path(tmp_path, SID).name == f"{SID}.issue-2.md"


def test_drafting_context_ignores_another_session_sharing_the_directory(tmp_path):
    other = _draft(tmp_path, "issue-7.md", "# Theirs\n", session=OTHER_SID)

    allocated = hook.next_draft_path(tmp_path, SID)

    # Their index must not push ours along, and their draft must survive.
    assert allocated.name == f"{SID}.issue-0.md"
    assert other.exists()


def test_an_interrupted_draft_still_reserves_its_index(tmp_path):
    _draft(tmp_path, "issue-0.md" + hook.PUBLISHING_SUFFIX, "# Crashed\n")

    assert hook.next_draft_path(tmp_path, SID).name == f"{SID}.issue-1.md"


# The hook as a process: stdin JSON in, exit code and streams out


def _run_hook(payload: dict, tmp_path: Path) -> subprocess.CompletedProcess:
    environment = dict(os.environ)
    environment[hook.STATE_DIR_VARIABLE] = str(tmp_path / "state")
    return subprocess.run(
        [sys.executable, str(CLAUDE_ADAPTER), "--claude"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=environment,
    )


def test_publish_result_reaches_the_user_only_and_erases_the_prompt(tmp_path):
    result = _run_hook(
        {"session_id": SID, "cwd": str(tmp_path), "prompt": "/publish-issues"},
        tmp_path,
    )

    # Exit code 2 is what erases the prompt and shows stderr to the user
    # without ever putting it in the transcript.
    assert result.returncode == 2
    assert "No .harness/issue-drafts/" in result.stderr
    assert result.stdout == ""


def test_drafting_prompt_returns_context_as_json_on_stdout(tmp_path):
    result = _run_hook(
        {"session_id": SID, "cwd": str(tmp_path), "prompt": "/draft-issues split this"},
        tmp_path,
    )

    assert result.returncode == 0
    payload = json.loads(result.stdout)["hookSpecificOutput"]
    assert payload["hookEventName"] == "UserPromptSubmit"
    assert payload["additionalContext"]
    assert (tmp_path / hook.DRAFTS_DIR / ".gitignore").is_file()


def test_an_ordinary_prompt_passes_through_silently(tmp_path):
    result = _run_hook(
        {"session_id": SID, "cwd": str(tmp_path), "prompt": "what does this repo do?"},
        tmp_path,
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert not (tmp_path / ".harness" / "issue-drafts").exists()


def test_a_queued_notice_is_delivered_on_the_next_ordinary_prompt(tmp_path):
    hook.queue_notice(tmp_path, SID, [{"number": "42", "title": "Spec"}], 0)

    first = _run_hook(
        {"session_id": SID, "cwd": str(tmp_path), "prompt": "carry on"}, tmp_path
    )
    second = _run_hook(
        {"session_id": SID, "cwd": str(tmp_path), "prompt": "carry on"}, tmp_path
    )

    assert "#42" in json.loads(first.stdout)["hookSpecificOutput"]["additionalContext"]
    assert second.stdout == ""  # delivered exactly once
