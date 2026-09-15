"""Tests for the /publish-issues hook's label-line parsing.

The label declaration line (first non-empty line after the title) drives
which labels an issue is published with. Since difficulty/mode labels were
made optional and user-requested extra labels allowed, the line can now
carry any subset of tokens in any order - the hook must map known tokens
(`difficulty:*`, `mode:*`, `spec`) to their `[AI]-` prefixed label names, pass
extras through,
and skip cleanly (never publish with a partial label set) when the line is
missing or malformed.

publish_batch is exercised in --dry mode so no gh calls happen; gh_create_issue
is monkeypatched for the one path that must prove labels reach `gh`.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import portalocker
import pytest

HOOK = (
    Path(__file__).resolve().parents[2]
    / "harness" / "building" / "issue-writers" / "issues_core.py"
)
CLAUDE_ADAPTER = (
    Path(__file__).resolve().parents[2]
    / "harness" / "building" / "issue-writers" / "issue_writers_hook.py"
)

sys.path.insert(0, str(HOOK.parent))
import issues_core as hook  # noqa: E402

SID = "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55"
REAL_CLEAN_PUBLICATION_PARTS = hook.clean_publication_parts
REAL_GH_REPLACE_ISSUE_BODY = hook.gh_replace_issue_body
REAL_GH_REPLACE_COMMENT_BODY = hook.gh_replace_comment_body


@pytest.fixture(autouse=True)
def publication_remote(monkeypatch):
    monkeypatch.setattr(hook, "gh_repository", lambda: (True, "x/y"))
    monkeypatch.setattr(hook, "gh_find_reserved_issue", lambda *args: (True, None))
    monkeypatch.setattr(hook, "gh_existing_comment_parts", lambda *args: (True, set()))
    monkeypatch.setattr(hook, "gh_replace_issue_body", lambda *args: (True, ""))
    monkeypatch.setattr(hook, "clean_publication_parts", lambda *args: (True, ""))


def _labels(body: str):
    """extract_labels over a full draft body (title already stripped)."""
    return hook.extract_labels(body)


def _draft(tmp_path: Path, name: str, text: str) -> Path:
    batch = tmp_path / ".issues-gateway" / SID
    batch.mkdir(parents=True, exist_ok=True)
    path = batch / name
    path.write_text(text, encoding="utf-8")
    return path


def _dry_publish(tmp_path: Path):
    """Run publish_batch in dry mode against the batch dir under tmp_path."""
    report: list[str] = []
    count, failures = hook.publish_batch(
        tmp_path / ".issues-gateway" / SID, dry=True, report=report
    )
    return report, count, failures




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




def test_draft_without_labels_is_skipped(tmp_path):
    _draft(tmp_path, "issue-0.md", "# Title\n\n## Body\n\nno label line\n")
    report, count, failures = _dry_publish(tmp_path)
    assert count == 0 and failures == 1
    assert any("missing or malformed label line" in line for line in report)


def test_publish_uses_exact_parsed_labels(tmp_path, monkeypatch):
    created = []

    def fake_create(title, body, labels, parent=None):
        created.append((title, body, list(labels)))
        return True, "https://github.com/x/y/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    batch = tmp_path / ".issues-gateway" / SID
    batch.mkdir(parents=True)
    (batch / "issue-0.md").write_text(
        "# T\n\n> ci, mode:afk\n\nBody with {ref} kept\n", encoding="utf-8"
    )

    report: list[str] = []
    count, failures = hook.publish_batch(batch, dry=False, report=report)
    assert count == 1 and failures == 0
    assert created == [("T", hook.render_publication_parts("Body with {ref} kept", f"{SID}/0")[0], ["ci", "[AI]-afk"])]
    assert not (batch / "issue-0.md").exists()
    # The label line is stripped from the body that gets posted.
    assert "mode:afk" not in created[0][1]
    # ...and the number survives the draft it came from, in shared state
    # at the gateway root - one state file for the whole project, none per batch.
    published = _state(batch.parent)["published"]
    assert published[f"{SID}/0"]["number"] == "42"
    assert not (batch / hook.STATE_NAME).exists()


def test_failed_draft_keeps_resolved_references_after_success(tmp_path, monkeypatch):
    def fake_create(title, body, labels, parent=None):
        assert title == "First"
        return True, "https://github.com/x/y/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    batch = tmp_path / ".issues-gateway" / SID
    batch.mkdir(parents=True)
    (batch / "issue-0.md").write_text(
        "# First\n\n> mode:afk\n\nBody\n", encoding="utf-8"
    )
    (batch / "issue-1.md").write_text(
        f"# Second\n\n## Body\n\nBlocked by {SID}/0\n", encoding="utf-8"
    )

    report: list[str] = []
    count, failures = hook.publish_batch(batch, dry=False, report=report)

    assert count == 1 and failures == 1
    assert not (batch / "issue-0.md").exists()
    assert "Blocked by #42" in (batch / "issue-1.md").read_text(encoding="utf-8")
    assert any("missing or malformed label line" in line for line in report)


def test_references_are_plain_text_and_resolve_to_bare_numbers():
    # In-file references are "session-id/{i}" as plain text - no backticks,
    # no braces - and resolve to a bare "#n", because GitHub only autolinks
    # issue numbers that aren't inside inline code.
    body = f"Blocked by {SID}/0\nSee also {SID}/0 and {SID}/1"
    resolved, unresolved = hook.resolve_references(body, {f"{SID}/0": "42"})
    assert "Blocked by #42" in resolved
    assert resolved.count("#42") == 2
    assert unresolved == [f"{SID}/1"]


def test_dry_run_reports_each_draft_with_labels(tmp_path):
    _draft(tmp_path, "issue-0.md", "# A\n\n> difficulty:basic\n\nbody a\n")
    _draft(tmp_path, "issue-1.md", "# B\n\n> bug, mode:hitl\n\nbody b\n")
    report, count, failures = _dry_publish(tmp_path)
    assert count == 2 and failures == 0
    assert any('"A" [[AI]-basic-difficulty]' in line for line in report)
    assert any('"B" [bug, [AI]-hitl]' in line for line in report)


def test_prompt_pattern_matches_with_or_without_dry():
    assert hook.PROMPT_PATTERN.match("/publish-issues")
    assert hook.PROMPT_PATTERN.match("/publish-issue")
    assert hook.PROMPT_PATTERN.match("/publish-issues --dry")
    assert not hook.PROMPT_PATTERN.match("/publish-issuesx")
    assert not hook.PROMPT_PATTERN.match("hello /publish-issues")




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




def _capture_creates(monkeypatch, urls):
    """Monkeypatch gh_create_issue, returning the list it records into."""
    created = []
    numbers = iter(urls)

    def fake_create(title, body, labels, parent=None):
        created.append({"title": title, "body": body, "parent": parent})
        return True, next(numbers)

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    return created


def test_declared_parent_reaches_gh_and_is_stripped_from_the_body(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(
        tmp_path,
        "issue-0.md",
        "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n\n## What to build\n\nthing\n",
    )

    report: list[str] = []
    batch = tmp_path / ".issues-gateway" / SID
    count, failures = hook.publish_batch(batch, dry=False, report=report)

    assert (count, failures) == (1, 0)
    assert created[0]["parent"] == "42"
    assert created[0]["body"] == hook.render_publication_parts("## What to build\n\nthing", f"{SID}/0")[0]
    assert any("sub-issue of #42" in line for line in report)


def test_parent_reference_resolves_within_one_run(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    created = _capture_creates(
        monkeypatch,
        ["https://github.com/x/y/issues/42", "https://github.com/x/y/issues/43"],
    )
    _draft(tmp_path, "issue-0.md", "# Spec\n\n> spec\n\n## Problem\n\nx\n")
    _draft(
        tmp_path,
        "issue-1.md",
        f"# Child\n\n> mode:afk\n\n## Parent\n\n{SID}/0\n\n## What\n\ny\n",
    )

    report: list[str] = []
    count, failures = hook.publish_batch(
        tmp_path / ".issues-gateway" / SID, dry=False, report=report
    )

    assert (count, failures) == (2, 0)
    assert [(c["title"], c["parent"]) for c in created] == [
        ("Spec", None),
        ("Child", "42"),
    ]


def test_parent_reference_resolves_from_state_in_a_later_run(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    batch = tmp_path / ".issues-gateway" / SID

    # Run 1: the spec is published on its own and its draft is deleted.
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# Spec\n\n> spec\n\n## Problem\n\nx\n")
    hook.publish_batch(batch, dry=False, report=[])
    assert not (batch / "issue-0.md").exists()

    # Run 2: an issue drafted afterwards still resolves it by filename index.
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(
        tmp_path,
        "issue-1.md",
        f"# Child\n\n> mode:afk\n\n## Parent\n\n{SID}/0\n\n## What\n\ny\n",
    )
    count, failures = hook.publish_batch(batch, dry=False, report=[])

    assert (count, failures) == (1, 0)
    assert created[0]["parent"] == "42"


def test_blocker_reference_resolves_across_runs_from_state(tmp_path, monkeypatch):
    batch = tmp_path / ".issues-gateway" / SID

    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# First\n\n> mode:afk\n\nbody\n")
    hook.publish_batch(batch, dry=False, report=[])

    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(tmp_path, "issue-1.md", f"# Second\n\n> mode:afk\n\nBlocked by {SID}/0\n")
    count, failures = hook.publish_batch(batch, dry=False, report=[])

    assert (count, failures) == (1, 0)
    assert "Blocked by #42" in created[0]["body"]


def test_unresolvable_parent_leaves_the_draft_for_a_rerun(tmp_path):
    _draft(tmp_path, "issue-0.md", f"# A\n\n> mode:afk\n\n## Parent\n\n{SID}/9\n")
    report, count, failures = _dry_publish(tmp_path)

    assert (count, failures) == (0, 1)
    assert any(f"parent {SID}/9" in line for line in report)
    assert (tmp_path / ".issues-gateway" / SID / "issue-0.md").exists()


def test_old_gh_links_after_creating_and_keeps_the_reference_in_the_body(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: False)
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    links = []

    def fake_link(child, parent):
        links.append((child, parent))
        return True, ""

    monkeypatch.setattr(hook, "gh_link_parent", fake_link)
    _draft(
        tmp_path,
        "issue-0.md",
        f"# Child\n\n> mode:afk\n\n## Parent\n\n#42\n\n## Blocked by\n\n{SID}/0\n",
    )
    # Its own key resolves from the shared state seeded below, not from
    # this run.
    batch = tmp_path / ".issues-gateway" / SID
    hook._write_json_dict(
        batch.parent / hook.STATE_NAME,
        {"published": {f"{SID}/0": {"number": "41"}}},
    )

    count, failures = hook.publish_batch(
        tmp_path / ".issues-gateway" / SID, dry=False, report=[]
    )

    assert (count, failures) == (1, 0)
    assert links == [("43", "42")]
    # Fallback path: the reference stays in the body, references still resolve.
    assert "## Parent" in created[0]["body"]
    assert "#41" in created[0]["body"]


def test_dry_run_previews_the_sub_issue_link(tmp_path):
    _draft(tmp_path, "issue-0.md", "# A\n\n> mode:afk\n\n## Parent\n\n#42\n")
    report, count, failures = _dry_publish(tmp_path)

    assert (count, failures) == (1, 0)
    assert any("sub-issue of #42" in line for line in report)
    # A dry run must not write state.
    assert not (tmp_path / ".issues-gateway" / hook.STATE_NAME).exists()




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


@pytest.mark.parametrize("issue", [
    {"title": "Another issue", "body": "body"},
    {"title": "T", "body": "Another body"},
    None,
])
def test_create_rejects_a_url_whose_issue_does_not_match(monkeypatch, issue):
    def run(args, **kwargs):
        output = json.dumps(issue) if args[2] == "view" else "https://github.com/x/y/issues/336\n"
        return subprocess.CompletedProcess(args, 0, output, "")

    monkeypatch.setattr(hook.subprocess, "run", run)
    ok, error = hook.gh_create_issue("T", "body", [])
    assert not ok
    assert "could not verify" in error and "/336" in error


def test_small_issue_recovers_lost_response_without_recreating(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# Runtime\n\n> mode:afk\n\nbody")
    attempts = []

    def create(*args):
        attempts.append(args)
        return False, "response lost after creation"

    monkeypatch.setattr(hook, "gh_create_issue", create)
    assert hook.publish_batch(path.parent, False, []) == (0, 1)
    assert path.exists()
    assert not _state(path.parent.parent).get("published")

    # An absent marker after an ambiguous response must never trigger a retrying create.
    assert hook.publish_batch(path.parent, False, []) == (0, 1)
    assert len(attempts) == 1
    monkeypatch.setattr(hook, "gh_find_reserved_issue", lambda *args: (
        True, {"number": 335, "url": "https://github.com/x/y/issues/335"}
    ))
    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert len(attempts) == 1
    assert not path.exists()
    record = _state(path.parent.parent)["published"][f"{SID}/0"]
    assert record["number"] == "335" and record["title"] == "Runtime"


def test_successful_publish_leaves_the_remote_body_marker_free(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# Runtime\n\n> mode:afk\n\nbody")
    remote = {"title": "", "body": ""}

    def fake_run(args, **kwargs):
        if args[:3] == ["gh", "issue", "create"]:
            remote["title"] = args[args.index("--title") + 1]
            remote["body"] = Path(args[args.index("--body-file") + 1]).read_text(
                encoding="utf-8"
            )
            return subprocess.CompletedProcess(
                args, 0, "https://github.com/x/y/issues/335\n", ""
            )
        if args[:3] == ["gh", "issue", "view"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(remote), "")
        raise AssertionError(args)

    monkeypatch.setattr(hook, "run_gh", fake_run)

    def replace_body(issue_url, expected_body, clean_body):
        assert issue_url.endswith("/335")
        assert remote["body"] == expected_body
        remote["body"] = clean_body
        return True, ""

    monkeypatch.setattr(hook, "gh_replace_issue_body", replace_body)
    monkeypatch.setattr(hook, "clean_publication_parts", REAL_CLEAN_PUBLICATION_PARTS)

    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert remote["body"] == "body"


def test_failed_marker_cleanup_retries_without_recreating(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# Runtime\n\n> mode:afk\n\nbody")
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/335"])
    attempts = []

    def clean(*args):
        attempts.append(args)
        if len(attempts) == 1:
            return False, "temporary edit failure"
        return True, ""

    monkeypatch.setattr(hook, "clean_publication_parts", clean)

    assert hook.publish_batch(path.parent, False, []) == (0, 1)
    assert path.exists()
    assert _state(path.parent.parent)["inflight"][f"{SID}/0"]["issue_number"] == "335"

    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert len(created) == 1
    assert len(attempts) == 2
    assert not path.exists()


def test_cleanup_failure_retains_recovery_state(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody")
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/335"])
    with monkeypatch.context() as patch:
        def fail_delete(path):
            raise PermissionError("draft is open in another process")
        patch.setattr(hook, "delete_published_draft", fail_delete)
        with pytest.raises(PermissionError):
            hook.publish_batch(path.parent, False, [])
    assert path.exists()
    assert _state(path.parent.parent)["inflight"][f"{SID}/0"]["issue_number"] == "335"
    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert len(created) == 1
    assert not path.exists()


def test_recovery_retries_parent_link_after_partial_native_create(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n## Parent\n\n#332\n\nbody")
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    monkeypatch.setattr(hook, "gh_create_issue", lambda *args: (False, "parent link failed after create"))
    assert hook.publish_batch(path.parent, False, []) == (0, 1)
    monkeypatch.setattr(hook, "gh_find_reserved_issue", lambda *args: (
        True, {"number": 335, "url": "https://github.com/x/y/issues/335"}
    ))
    links = []
    monkeypatch.setattr(hook, "gh_link_parent", lambda child, parent: (links.append((child, parent)) or True, ""))
    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert links == [("335", "332")]
    assert _state(path.parent.parent)["published"][f"{SID}/0"]["parent"] == "332"


def test_overlapping_publish_does_not_create_twice_without_portalocker(tmp_path, monkeypatch):
    path = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody")
    monkeypatch.delitem(sys.modules, "portalocker")
    overlapping_report = []

    def create(*args):
        assert hook.publish_batch(path.parent, False, overlapping_report) == (0, 1)
        return True, "https://github.com/x/y/issues/335"

    monkeypatch.setattr(hook, "gh_create_issue", create)
    assert hook.publish_batch(path.parent, False, []) == (1, 0)
    assert any("already processing" in line for line in overlapping_report)
    assert _state(path.parent.parent)["published"][f"{SID}/0"]["number"] == "335"


def test_native_state_lock_rejects_overlapping_writer(tmp_path, monkeypatch):
    gateway = _gateway(tmp_path)
    monkeypatch.delitem(sys.modules, "portalocker")
    with hook.file_lock(gateway / hook.LOCK_NAME) as acquired:
        assert acquired
        assert not hook.record_published(f"{SID}/0", {"number": "335"}, gateway)
    assert hook.record_published(f"{SID}/0", {"number": "335"}, gateway)




def _rendered_content(payload: str) -> str:
    return payload.split("\n\n", 1)[1].rsplit("\n\n<!-- issues-gateway:", 1)[0]


def test_body_at_hard_limit_splits_to_leave_room_for_recovery_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "gh_comment_issue", lambda *args: (True, ""))
    body = "é" * hook.GITHUB_BODY_LIMIT
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", f"# T\n\n> mode:afk\n\n{body}\n")

    count, failures = hook.publish_batch(
        tmp_path / ".issues-gateway" / SID, dry=False, report=[]
    )

    assert (count, failures) == (1, 0)
    assert created[0]["body"] == hook.render_publication_parts(body, f"{SID}/0")[0]
    assert len(created[0]["body"]) <= hook.GITHUB_BODY_LIMIT
    assert "Part 1 of 2" in created[0]["body"]


def test_rendered_parts_are_ordered_complete_and_below_both_limits():
    for body in [
        ("Unicode café 🚀\n\n" * 6000),
        ("line\n" * 20_000),
        ("x" * 140_000),
    ]:
        parts = hook.render_oversized_parts(body, f"{SID}/0")
        assert len(parts) >= 2
        assert all(len(part) <= hook.CHUNK_TARGET for part in parts)
        assert all(len(part) <= hook.GITHUB_BODY_LIMIT for part in parts)
        assert "".join(_rendered_content(part) for part in parts) == body
        for index, part in enumerate(parts, 1):
            assert hook.part_marker(
                f"{SID}/0", hook.content_digest(body), index, len(parts)
            ) in part


def test_chunker_prefers_paragraph_then_line_boundaries():
    body = "first paragraph\n\nsecond paragraph\nlast line"
    chunks = hook.chunk_markdown(body, 18)
    assert chunks[0] == "first paragraph\n\n"

    chunks = hook.chunk_markdown("first line\nsecond-line-is-long", 15)
    assert chunks[0] == "first line\n"


def test_chunker_closes_and_reopens_an_unavoidably_split_fence():
    body = "```python\n" + ("print('x')\n" * 10_000) + "```"
    parts = hook.render_oversized_parts(body, f"{SID}/0")
    contents = [_rendered_content(part) for part in parts]
    assert contents[0].endswith("```")
    assert contents[1].startswith("```python\n")
    repaired = "\n".join(contents).replace("\n```\n```python\n", "\n", 1)
    assert repaired == body


def _mock_oversized_remote(monkeypatch, *, comment_failure=None, existing=None):
    calls = {
        "creates": [],
        "create_labels": [],
        "create_parents": [],
        "comments": [],
        "finds": 0,
    }
    monkeypatch.setattr(hook, "gh_repository", lambda: (True, "x/y"))

    def find(*args):
        calls["finds"] += 1
        return True, None

    monkeypatch.setattr(hook, "gh_find_reserved_issue", find)

    def create(title, body, labels, parent=None):
        calls["creates"].append(body)
        calls["create_labels"].append(labels)
        calls["create_parents"].append(parent)
        return True, "https://github.com/x/y/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", create)
    monkeypatch.setattr(
        hook, "gh_existing_comment_parts", lambda *args: (True, set(existing or set()))
    )

    def comment(url, body):
        part = int(hook.ISSUE_MARKER_PATTERN.search(body).group("part"))
        calls["comments"].append(part)
        if comment_failure == part:
            return False, "boom"
        return True, "ok"

    monkeypatch.setattr(hook, "gh_comment_issue", comment)
    return calls


def test_oversized_publish_records_comments_then_cleans_up(tmp_path, monkeypatch):
    calls = _mock_oversized_remote(monkeypatch)
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 70_000)
    )
    batch = path.parent
    created = []

    count, failures = hook.publish_batch(
        batch, dry=False, report=[], created=created
    )

    assert (count, failures) == (1, 0)
    assert len(calls["creates"]) == 1 and calls["comments"] == [2]
    assert not path.exists()
    state = _state(batch.parent)
    assert f"{SID}/0" not in state.get("inflight", {})
    assert state["published"][f"{SID}/0"]["url"].endswith("/42")
    assert created[0]["number"] == "42"


def test_oversized_publish_leaves_every_remote_part_marker_free(tmp_path, monkeypatch):
    remote = {"issue": "", "comments": []}

    def create(title, body, labels, parent=None):
        remote["issue"] = body
        return True, "https://github.com/x/y/issues/42"

    def comment(issue_url, body):
        remote["comments"].append(
            {"id": len(remote["comments"]) + 100, "body": body}
        )
        return True, "ok"

    def replace_issue(issue_url, expected_body, clean_body):
        assert remote["issue"] == expected_body
        remote["issue"] = clean_body
        return True, ""

    def list_comments(repository, issue_number):
        return True, [dict(value) for value in remote["comments"]]

    def replace_comment(repository, comment_id, expected_body, clean_body):
        found = next(value for value in remote["comments"] if value["id"] == comment_id)
        assert found["body"] == expected_body
        found["body"] = clean_body
        return True, ""

    monkeypatch.setattr(hook, "gh_create_issue", create)
    monkeypatch.setattr(hook, "gh_comment_issue", comment)
    monkeypatch.setattr(hook, "gh_replace_issue_body", replace_issue)
    monkeypatch.setattr(hook, "gh_list_issue_comments", list_comments, raising=False)
    monkeypatch.setattr(hook, "gh_replace_comment_body", replace_comment, raising=False)
    monkeypatch.setattr(hook, "clean_publication_parts", REAL_CLEAN_PUBLICATION_PARTS)
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 70_000)
    )

    assert hook.publish_batch(path.parent, dry=False, report=[]) == (1, 0)
    assert "<!-- issues-gateway:" not in remote["issue"]
    assert remote["comments"]
    assert all(
        "<!-- issues-gateway:" not in value["body"] for value in remote["comments"]
    )


def test_interrupted_oversized_cleanup_resumes_without_reposting(
    tmp_path, monkeypatch,
):
    remote = {"issue": "", "comments": []}
    calls = {"creates": 0, "comments": 0, "cleanup_failures": 0}

    def create(title, body, labels, parent=None):
        calls["creates"] += 1
        remote["issue"] = body
        return True, "https://github.com/x/y/issues/42"

    def comment(issue_url, body):
        calls["comments"] += 1
        remote["comments"].append({"id": calls["comments"] + 100, "body": body})
        return True, "ok"

    def replace_issue(issue_url, expected_body, clean_body):
        if remote["issue"].rstrip() == clean_body.rstrip():
            return True, ""
        assert remote["issue"] == expected_body
        remote["issue"] = clean_body
        return True, ""

    def list_comments(repository, issue_number):
        return True, [dict(value) for value in remote["comments"]]

    def replace_comment(repository, comment_id, expected_body, clean_body):
        found = next(value for value in remote["comments"] if value["id"] == comment_id)
        if "part:3/3" in expected_body and calls["cleanup_failures"] == 0:
            calls["cleanup_failures"] += 1
            return False, "temporary edit failure"
        found["body"] = clean_body
        return True, ""

    monkeypatch.setattr(hook, "gh_create_issue", create)
    monkeypatch.setattr(hook, "gh_comment_issue", comment)
    monkeypatch.setattr(hook, "gh_replace_issue_body", replace_issue)
    monkeypatch.setattr(hook, "gh_list_issue_comments", list_comments)
    monkeypatch.setattr(hook, "gh_replace_comment_body", replace_comment)
    monkeypatch.setattr(hook, "clean_publication_parts", REAL_CLEAN_PUBLICATION_PARTS)
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 130_000)
    )

    assert hook.publish_batch(path.parent, dry=False, report=[]) == (0, 1)
    assert path.exists()
    assert calls == {"creates": 1, "comments": 2, "cleanup_failures": 1}

    assert hook.publish_batch(path.parent, dry=False, report=[]) == (1, 0)
    assert calls == {"creates": 1, "comments": 2, "cleanup_failures": 1}
    assert not path.exists()
    assert "issues-gateway:" not in remote["issue"]
    assert all("issues-gateway:" not in value["body"] for value in remote["comments"])


def test_labels_references_and_native_parent_are_processed_before_chunking(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)
    calls = _mock_oversized_remote(monkeypatch)
    path = _draft(
        tmp_path,
        "issue-1.md",
        (
            "# Child\n\n> bug, mode:afk\n\n## Parent\n\n#42\n\n## What\n\n"
            f"Blocked by {SID}/0\n\n" + ("x" * 70_000)
        ),
    )
    hook._write_json_dict(
        path.parent.parent / hook.STATE_NAME,
        {"published": {f"{SID}/0": {"number": "41"}}},
    )

    assert hook.publish_batch(path.parent, dry=False, report=[]) == (1, 0)
    assert calls["create_labels"] == [["bug", "[AI]-afk"]]
    assert calls["create_parents"] == ["42"]
    assert f"{SID}/0" not in calls["creates"][0]
    assert "Blocked by #41" in calls["creates"][0]
    assert "## Parent" not in calls["creates"][0]


def test_old_gh_parent_fallback_is_included_before_chunking(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: False)
    calls = _mock_oversized_remote(monkeypatch)
    linked = []
    monkeypatch.setattr(
        hook,
        "gh_link_parent",
        lambda child, parent: (linked.append((child, parent)) or True, ""),
    )
    path = _draft(
        tmp_path,
        "issue-0.md",
        "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n\n" + ("x" * 70_000),
    )

    assert hook.publish_batch(path.parent, dry=False, report=[]) == (1, 0)
    assert "## Parent\n\n#42" in calls["creates"][0]
    assert linked == [("42", "42")]


def test_comment_failure_resumes_existing_issue_without_duplicates(tmp_path, monkeypatch):
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 130_000)
    )
    batch = path.parent
    first = _mock_oversized_remote(monkeypatch, comment_failure=3)
    report = []

    assert hook.publish_batch(batch, dry=False, report=report) == (0, 1)
    assert first["creates"] and first["comments"] == [2, 3]
    assert path.exists()
    state = _state(batch.parent)
    assert state["inflight"][f"{SID}/0"]["completed_parts"] == [1, 2]

    second = _mock_oversized_remote(monkeypatch, existing={2})
    assert hook.publish_batch(batch, dry=False, report=[]) == (1, 0)
    assert second["creates"] == []
    assert second["finds"] == 0
    assert second["comments"] == [3]
    assert not path.exists()


def test_recovery_finds_marker_issue_when_url_was_not_recorded(tmp_path, monkeypatch):
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 70_000)
    )
    batch = path.parent
    calls = _mock_oversized_remote(monkeypatch)
    monkeypatch.setattr(hook, "gh_create_issue", lambda *args: (False, "lost response"))
    assert hook.publish_batch(batch, dry=False, report=[]) == (0, 1)

    marker_body = hook.render_oversized_parts("x" * 70_000, f"{SID}/0")[0]
    monkeypatch.setattr(
        hook,
        "gh_find_reserved_issue",
        lambda *args: (
            True,
            {
                "number": 42,
                "url": "https://github.com/x/y/issues/42",
                "body": marker_body,
                "createdAt": "9999-01-01T00:00:00Z",
            },
        ),
    )
    monkeypatch.setattr(
        hook, "gh_create_issue", lambda *args: (_ for _ in ()).throw(AssertionError())
    )
    assert hook.publish_batch(batch, dry=False, report=[]) == (1, 0)
    assert calls["comments"] == [2]


def test_changed_draft_refuses_to_resume_and_reports_partial_url(tmp_path, monkeypatch):
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 130_000)
    )
    batch = path.parent
    _mock_oversized_remote(monkeypatch, comment_failure=3)
    assert hook.publish_batch(batch, dry=False, report=[]) == (0, 1)
    path.write_text(path.read_text(encoding="utf-8") + "changed", encoding="utf-8")

    calls = _mock_oversized_remote(monkeypatch)
    report = []
    assert hook.publish_batch(batch, dry=False, report=report) == (0, 1)
    assert calls["creates"] == [] and calls["comments"] == []
    assert any("draft changed" in line and "/42" in line for line in report)


def test_shrinking_partial_draft_below_limit_still_refuses_duplicate(tmp_path, monkeypatch):
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 130_000)
    )
    batch = path.parent
    _mock_oversized_remote(monkeypatch, comment_failure=3)
    assert hook.publish_batch(batch, dry=False, report=[]) == (0, 1)
    path.write_text("# T\n\n> mode:afk\n\nshort now", encoding="utf-8")

    monkeypatch.setattr(
        hook, "gh_create_issue", lambda *args: (_ for _ in ()).throw(AssertionError())
    )
    report = []
    assert hook.publish_batch(batch, dry=False, report=report) == (0, 1)
    assert any("refusing to mix versions" in line and "/42" in line for line in report)


def test_failed_reservation_makes_no_remote_issue_or_comment(tmp_path, monkeypatch):
    path = _draft(
        tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 70_000)
    )
    monkeypatch.setattr(hook, "gh_repository", lambda: (True, "x/y"))
    monkeypatch.setattr(hook, "reserve_inflight", lambda *args: (False, None))
    monkeypatch.setattr(
        hook, "gh_create_issue", lambda *args: (_ for _ in ()).throw(AssertionError())
    )
    monkeypatch.setattr(
        hook, "gh_comment_issue", lambda *args: (_ for _ in ()).throw(AssertionError())
    )

    report = []
    assert hook.publish_batch(
        path.parent,
        dry=False,
        report=report,
        mutation_prelude=lambda: (_ for _ in ()).throw(AssertionError()),
    ) == (0, 1)
    assert path.exists()
    assert any("no GitHub changes were made" in line for line in report)


def test_comment_failure_does_not_stop_unrelated_drafts(tmp_path, monkeypatch):
    first = _draft(
        tmp_path, "issue-0.md", "# Big\n\n> mode:afk\n\n" + ("x" * 130_000)
    )
    second = _draft(tmp_path, "issue-1.md", "# Small\n\n> mode:afk\n\nsmall")
    calls = _mock_oversized_remote(monkeypatch, comment_failure=3)

    count, failures = hook.publish_batch(first.parent, dry=False, report=[])

    assert (count, failures) == (1, 1)
    assert first.exists() and not second.exists()
    assert calls["comments"] == [2, 3]


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


def test_issue_body_cleanup_uses_body_file_and_is_idempotent(monkeypatch):
    remote = {"body": "authored\n\n<!-- marker -->"}
    edits = []

    def fake_run(args, **kwargs):
        if args[:3] == ["gh", "issue", "view"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(remote), "")
        if args[:3] == ["gh", "issue", "edit"]:
            assert "--body-file" in args and "--body" not in args
            remote["body"] = Path(args[args.index("--body-file") + 1]).read_text(
                encoding="utf-8"
            )
            edits.append(remote["body"])
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError(args)

    monkeypatch.setattr(hook, "run_gh", fake_run)
    assert REAL_GH_REPLACE_ISSUE_BODY(
        "https://github.com/x/y/issues/42",
        "authored\n\n<!-- marker -->",
        "authored",
    ) == (True, "")
    assert remote["body"] == "authored"
    assert len(edits) == 1

    assert REAL_GH_REPLACE_ISSUE_BODY(
        "https://github.com/x/y/issues/42",
        "authored\n\n<!-- marker -->",
        "authored",
    ) == (True, "")
    assert len(edits) == 1


def test_comment_cleanup_sends_utf8_json_and_verifies_the_response(monkeypatch):
    captured = []

    def fake_run(args, **kwargs):
        if "--input" not in args:
            return subprocess.CompletedProcess(
                args, 0, json.dumps({"body": "cafÃ©\n\n<!-- marker -->"}), ""
            )
        payload = json.loads(
            Path(args[args.index("--input") + 1]).read_text(encoding="utf-8")
        )
        captured.append((args, payload))
        return subprocess.CompletedProcess(
            args, 0, json.dumps(payload, ensure_ascii=False), ""
        )

    monkeypatch.setattr(hook, "run_gh", fake_run)
    assert REAL_GH_REPLACE_COMMENT_BODY(
        "x/y", 123, "cafÃ©\n\n<!-- marker -->", "cafÃ©"
    ) == (True, "")
    args, payload = captured[0]
    assert args[:4] == ["gh", "api", "--method", "PATCH"]
    assert args[4] == "repos/x/y/issues/comments/123"
    assert payload == {"body": "cafÃ©"}


def test_comment_cleanup_refuses_to_overwrite_a_changed_comment(monkeypatch):
    def fake_run(args, **kwargs):
        assert "--method" not in args
        return subprocess.CompletedProcess(
            args, 0, json.dumps({"body": "edited by a user"}), ""
        )

    monkeypatch.setattr(hook, "run_gh", fake_run)
    ok, error = REAL_GH_REPLACE_COMMENT_BODY(
        "x/y", 123, "authored\n\n<!-- marker -->", "authored"
    )
    assert not ok
    assert "changed" in error


def test_oversized_dry_run_reports_parts_without_state_or_gh(tmp_path, monkeypatch):
    _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\n" + ("x" * 70_000))
    monkeypatch.setattr(
        hook.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError())
    )

    report, count, failures = _dry_publish(tmp_path)

    assert (count, failures) == (1, 0)
    assert any("2 parts (1 continuation comment(s))" in line for line in report)
    assert not (tmp_path / ".issues-gateway" / hook.STATE_NAME).exists()


def test_state_migration_preserves_valid_maps_and_drops_bad_inflight(tmp_path):
    gateway = _gateway(tmp_path)
    hook._write_json_dict(
        gateway / hook.STATE_NAME,
        {
            "published": {f"{SID}/0": {"number": "42"}},
            "pending_notice": {"created": [], "failed": 1},
            "inflight": {
                f"{SID}/1": {"fingerprint": "ok"},
                f"{SID}/2": "bad",
            },
        },
    )

    state = hook._read_state(gateway)
    assert state["published"][f"{SID}/0"]["number"] == "42"
    assert state["pending_notice"]["failed"] == 1
    assert state["inflight"] == {f"{SID}/1": {"fingerprint": "ok"}}




def _gateway(tmp_path: Path) -> Path:
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir(exist_ok=True)
    return gateway


def _state(gateway: Path) -> dict:
    return hook._read_json_dict(gateway / hook.STATE_NAME)


def test_notice_accumulates_across_runs_and_is_delivered_once(tmp_path):
    gateway = _gateway(tmp_path)
    hook.queue_notice(
        [{"number": "42", "title": "Spec", "labels": ["[AI]-spec"]}], 0, gateway
    )
    # Two publish runs in a row: nothing was flushed in between.
    hook.queue_notice([{"number": "43", "title": "Child", "labels": []}], 1, gateway)

    notice = hook.flush_notice(gateway)
    assert "#42" in notice and "#43" in notice
    assert "1 draft(s) failed" in notice
    assert "## Parent" in notice  # tells the agent how to use the numbers
    assert hook.flush_notice(gateway) is None
    assert "pending_notice" not in _state(gateway)


def test_nothing_published_queues_nothing(tmp_path):
    gateway = _gateway(tmp_path)
    hook.queue_notice([], 0, gateway)
    assert not (gateway / hook.STATE_NAME).exists()
    assert hook.flush_notice(gateway) is None


def test_corrupt_notice_is_dropped_not_raised(tmp_path):
    gateway = _gateway(tmp_path)
    hook._write_json_dict(gateway / hook.STATE_NAME, {"pending_notice": "not-a-dict"})
    assert hook.flush_notice(gateway) is None
    assert "pending_notice" not in _state(gateway)


def test_corrupt_state_degrades_to_empty(tmp_path):
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    (gateway / hook.STATE_NAME).write_text("[]", encoding="utf-8")
    assert hook.seed_from_state(gateway) == {}


def test_seed_from_state_maps_keys_to_numbers(tmp_path):
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    hook._write_json_dict(
        gateway / hook.STATE_NAME,
        {
            "published": {
                f"{SID}/0": {"number": "42", "title": "Spec"},
                f"{SID}/1": {"number": 43},  # stray ints still resolve
                f"{SID}/2": "not-an-entry",  # malformed entries are dropped
                f"{SID}/3": {"no-number": None},  # entries without a number too
            }
        },
    )
    assert hook.seed_from_state(gateway) == {f"{SID}/0": "42", f"{SID}/1": "43"}


def test_seed_from_state_reads_legacy_published_file(tmp_path):
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    hook._write_json_dict(
        gateway / hook.LEGACY_LEDGER_NAME,
        {f"{SID}/0": {"number": "42", "title": "Spec"}},
    )

    assert hook.seed_from_state(gateway) == {f"{SID}/0": "42"}


def test_record_published_appends_to_shared_state(tmp_path):
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    assert hook.record_published(f"{SID}/0", {"number": "42"}, gateway)
    assert hook.record_published(f"{SID}/1", {"number": "43"}, gateway)
    data = _state(gateway)["published"]
    assert data[f"{SID}/0"]["number"] == "42"
    assert data[f"{SID}/1"]["number"] == "43"


def test_record_published_warns_instead_of_clobbering_locked_state(tmp_path):
    """The loser of a state-file race must not pause or overwrite the winner.

    The lock sidecar is held by the winner; the loser's _locked_state
    fails fast with fail_when_locked and yields None, the caller reports a
    warning, and the state file simply keeps the winner's entries.
    """
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir()
    lock_path = gateway / hook.LOCK_NAME
    lock_path.touch()
    with portalocker.Lock(str(lock_path), mode="a", timeout=10, fail_when_locked=True):
        assert hook.record_published(f"{SID}/0", {"number": "42"}, gateway) is False
    assert hook.seed_from_state(gateway) == {}


def test_publish_under_state_contention_keeps_draft_without_creating(tmp_path, monkeypatch):
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")
    batch = tmp_path / ".issues-gateway" / SID
    lock_path = batch.parent / hook.LOCK_NAME
    lock_path.touch()

    report: list[str] = []
    with portalocker.Lock(str(lock_path), mode="a", timeout=10, fail_when_locked=True):
        count, failures = hook.publish_batch(batch, dry=False, report=report)

    assert (count, failures) == (0, 1)
    assert (batch / "issue-0.md").exists()
    assert created == []
    assert any("could not reserve shared state" in line for line in report)


def test_notice_stays_under_the_additional_context_cap(tmp_path):
    many = [{"number": str(n), "title": "t" * 60, "labels": []} for n in range(120)]
    text = hook.format_notice(many, 0)
    assert f"and {120 - hook.MAX_NOTICE_ENTRIES} more" in text
    assert len(text) < 10_000


def test_flush_notice_reads_legacy_notice_file(tmp_path):
    gateway = _gateway(tmp_path)
    hook._write_json_dict(
        gateway / hook.LEGACY_NOTICE_NAME,
        {"created": [{"number": "42", "title": "Spec", "labels": []}], "failed": 0},
    )

    notice = hook.flush_notice(gateway)

    assert "#42" in notice
    assert "pending_notice" not in _state(gateway)




def _run_hook(tmp_path: Path, prompt: str):
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, (str(HOOK.parent), env.get("PYTHONPATH", "")))
    )
    return subprocess.run(
        [sys.executable, str(CLAUDE_ADAPTER), "--claude"],
        input=json.dumps({"prompt": prompt, "session_id": SID}),
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env=env,
    )


def test_next_prompt_carries_the_notice_as_additional_context(tmp_path):
    gateway = _gateway(tmp_path)
    hook.queue_notice(
        [{"number": "42", "title": "Spec", "labels": ["[AI]-spec"]}], 0, gateway
    )

    result = _run_hook(tmp_path, "now break this down")

    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    assert "pending_notice" not in _state(gateway)


def test_ordinary_prompt_without_a_notice_is_untouched(tmp_path):
    result = _run_hook(tmp_path, "hello")
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_drafting_prompt_prepares_and_injects_context(tmp_path):
    result = _run_hook(tmp_path, "/draft-issue add hook-based setup")

    assert result.returncode == 0
    payload = json.loads(result.stdout)
    context = payload["hookSpecificOutput"]["additionalContext"]
    assert context
    batch = tmp_path / ".issues-gateway" / SID
    assert batch.is_dir()
    assert (tmp_path / ".issues-gateway/.gitignore").read_text() == "*\n"

    (batch / "issue-0.md").write_text("# Existing\n", encoding="utf-8")
    result = _run_hook(tmp_path, "/draft-issue add another")
    context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    assert context


@pytest.mark.parametrize(
    "prompt",
    [
        "/draft-audit-issues convert the audit",
        "/draft-issues break this down",
        "/to-spec-draft-issue",
    ],
)
def test_all_claude_drafting_skills_trigger_context(prompt, tmp_path):
    result = _run_hook(tmp_path, prompt)
    assert result.returncode == 0
    context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    assert context


def test_spec_then_breakdown_across_two_publish_runs(tmp_path, monkeypatch):
    """The whole workflow: spec published, then issues drafted under it.

    The publish run produces no model turn, so the only way the second draft
    can carry "#42" is the notice the next prompt delivers.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    monkeypatch.setattr(hook, "parent_flag_supported", lambda: True)

    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    _draft(tmp_path, "issue-0.md", "# Spec\n\n> spec\n\n## Problem\n\nx\n")
    assert "Published 1 issue(s) successfully" in hook.publish_issues(False, SID)

    # What the agent is told on the next prompt.
    notice = hook.flush_notice()
    assert "#42" in notice and "Spec" in notice

    # ...and what it writes with that number.
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(tmp_path, "issue-1.md", "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n")
    hook.publish_issues(False, SID)

    assert created[0]["parent"] == "42"


def test_successful_publish_removes_empty_session_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert "Published 1 issue(s) successfully" in result
    assert not draft.parent.exists()


def test_publish_only_creates_issues_from_the_current_session(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/42"])
    current = _draft(tmp_path, "issue-0.md", "# Current\n\n> mode:afk\n\nbody\n")
    other_sid = "11111111-2222-4333-8444-555555555555"
    other_batch = tmp_path / ".issues-gateway" / other_sid
    other_batch.mkdir(parents=True)
    other = other_batch / "issue-0.md"
    other.write_text("# Other\n\n> mode:afk\n\nbody\n", encoding="utf-8")

    result = hook.publish_issues(False, SID)

    assert "Published 1 issue(s) successfully" in result
    assert [entry["title"] for entry in created] == ["Current"]
    assert not current.exists()
    assert other.exists()


def test_publish_keeps_session_folder_when_any_draft_fails(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(hook, "ensure_labels", lambda dry: [])
    monkeypatch.setattr(
        hook,
        "gh_create_issue",
        lambda title, body, labels, parent=None: (False, "GitHub unavailable"),
    )
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(False, SID)

    assert "1 failed or were skipped" in result
    assert draft.exists()
    assert draft.parent.is_dir()


def test_dry_run_keeps_session_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    draft = _draft(tmp_path, "issue-0.md", "# T\n\n> mode:afk\n\nbody\n")

    result = hook.publish_issues(True, SID)

    assert "1 issue(s) ready to publish" in result
    assert draft.exists()
    assert draft.parent.is_dir()


def test_a_publish_prompt_does_not_consume_the_notice(tmp_path):
    # The publish path exits 2 and produces no model turn, so flushing there
    # would throw the notice away without anyone reading it.
    gateway = _gateway(tmp_path)
    hook.queue_notice([{"number": "42", "title": "Spec", "labels": []}], 0, gateway)

    result = _run_hook(tmp_path, "/publish-issues")

    assert result.returncode == 2
    assert "No draft batch found for this session" in result.stderr
    assert "pending_notice" in _state(gateway)


def test_publish_prompt_only_includes_the_current_session(tmp_path):
    other_sid = "11111111-2222-4333-8444-555555555555"
    _draft(tmp_path, "issue-0.md", "# Current\n\n> mode:afk\n\nbody\n")
    other_batch = tmp_path / ".issues-gateway" / other_sid
    other_batch.mkdir(parents=True)
    (other_batch / "issue-0.md").write_text(
        "# Other session\n\n> mode:afk\n\nbody\n", encoding="utf-8"
    )

    result = _run_hook(tmp_path, "/publish-issues --dry")

    assert result.returncode == 2
    assert "Dry run complete: 1 issue(s) ready to publish" in result.stderr
