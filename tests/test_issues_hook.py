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
import subprocess
import sys
from pathlib import Path

HOOK = (
    Path(__file__).resolve().parent.parent
    / "harness" / "issues" / "hooks" / "publish_issues_UserPromptSubmit_hook.py"
)

sys.path.insert(0, str(HOOK.parent))
import publish_issues_UserPromptSubmit_hook as hook  # noqa: E402

SID = "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55"


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


# --- extract_labels: the label line grammar -------------------------------


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


# --- ensure_labels: create-only, existing labels never re-styled -------------


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


# --- publish_batch: what a full draft actually does ------------------------


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
    assert created == [("T", "Body with {ref} kept", ["ci", "[AI]-afk"])]
    assert not (batch / "issue-0.md").exists()
    # The label line is stripped from the body that gets posted.
    assert "mode:afk" not in created[0][1]
    # ...and the number survives the draft it came from.
    assert hook.load_ledger(batch)[f"{SID}/0"]["number"] == "42"


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


# --- extract_parent: what counts as a link, what stays prose ---------------


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


# --- publishing a sub-issue ------------------------------------------------


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
    assert created[0]["body"] == "## What to build\n\nthing"
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


def test_parent_reference_resolves_from_the_ledger_in_a_later_run(tmp_path, monkeypatch):
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


def test_blocker_reference_resolves_across_runs_from_the_ledger(tmp_path, monkeypatch):
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
    # Its own key resolves from the ledger seeded below, not from this run.
    (tmp_path / ".issues-gateway" / SID / hook.LEDGER_NAME).write_text(
        json.dumps({f"{SID}/0": {"number": "41"}}), encoding="utf-8"
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
    # A dry run must not write a ledger.
    assert not (tmp_path / ".issues-gateway" / SID / hook.LEDGER_NAME).exists()


# --- what actually reaches the gh command line -----------------------------


def _fake_gh(monkeypatch, calls, help_text="", returncode=0, stdout=""):
    def fake_run(args, **kwargs):
        calls.append(args)
        if args[:4] == ["gh", "issue", "create", "--help"]:
            return type("R", (), {"returncode": 0, "stdout": help_text, "stderr": ""})()
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


# --- the notice delivered to the agent on the next prompt ------------------


def _gateway(tmp_path: Path) -> Path:
    gateway = tmp_path / ".issues-gateway"
    gateway.mkdir(exist_ok=True)
    return gateway


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
    assert not (gateway / hook.NOTICE_NAME).exists()


def test_nothing_published_queues_nothing(tmp_path):
    gateway = _gateway(tmp_path)
    hook.queue_notice([], 0, gateway)
    assert not (gateway / hook.NOTICE_NAME).exists()
    assert hook.flush_notice(gateway) is None


def test_corrupt_notice_is_dropped_not_raised(tmp_path):
    gateway = _gateway(tmp_path)
    (gateway / hook.NOTICE_NAME).write_text("{ not json", encoding="utf-8")
    assert hook.flush_notice(gateway) is None
    assert not (gateway / hook.NOTICE_NAME).exists()


def test_corrupt_ledger_degrades_to_empty(tmp_path):
    batch = tmp_path / ".issues-gateway" / SID
    batch.mkdir(parents=True)
    (batch / hook.LEDGER_NAME).write_text("[]", encoding="utf-8")
    assert hook.load_ledger(batch) == {}
    assert hook.seed_from_ledgers([batch]) == {}


def test_notice_stays_under_the_additional_context_cap(tmp_path):
    many = [{"number": str(n), "title": "t" * 60, "labels": []} for n in range(120)]
    text = hook.format_notice(many, 0)
    assert f"and {120 - hook.MAX_NOTICE_ENTRIES} more" in text
    assert len(text) < 10_000


# --- end-to-end through the hook's stdin/stdout contract -------------------


def _run_hook(tmp_path: Path, prompt: str):
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"prompt": prompt, "session_id": SID}),
        capture_output=True,
        text=True,
        cwd=tmp_path,
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
    assert "#42" in payload["hookSpecificOutput"]["additionalContext"]
    assert not (gateway / hook.NOTICE_NAME).exists()


def test_ordinary_prompt_without_a_notice_is_untouched(tmp_path):
    result = _run_hook(tmp_path, "hello")
    assert result.returncode == 0
    assert result.stdout == ""


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
    assert "Published 1 issue(s) successfully" in hook.publish_issues(dry=False)

    # What the agent is told on the next prompt.
    notice = hook.flush_notice()
    assert "#42" in notice and "Spec" in notice

    # ...and what it writes with that number.
    created = _capture_creates(monkeypatch, ["https://github.com/x/y/issues/43"])
    _draft(tmp_path, "issue-1.md", "# Child\n\n> mode:afk\n\n## Parent\n\n#42\n")
    hook.publish_issues(dry=False)

    assert created[0]["parent"] == "42"


def test_a_publish_prompt_does_not_consume_the_notice(tmp_path):
    # The publish path exits 2 and produces no model turn, so flushing there
    # would throw the notice away without anyone reading it.
    gateway = _gateway(tmp_path)
    hook.queue_notice([{"number": "42", "title": "Spec", "labels": []}], 0, gateway)

    result = _run_hook(tmp_path, "/publish-issues")

    assert result.returncode == 2
    assert "No draft batches found" in result.stderr
    assert (gateway / hook.NOTICE_NAME).exists()
