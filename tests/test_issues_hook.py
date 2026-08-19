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
    labels, body = _labels("> difficulty:medium, mode:hitl\n\n## What\n")
    assert labels == ["[AI]-medium-difficulty", "[AI]-hitl"]
    assert body == "## What"
    labels, _ = _labels("> mode:afk, difficulty:high\n\nbody")
    assert labels == ["[AI]-afk", "[AI]-high-difficulty"]


def test_only_one_of_each_pair():
    labels, _ = _labels("> difficulty:low\n\nbody")
    assert labels == ["[AI]-low-difficulty"]
    labels, _ = _labels("> mode:afk\n\nbody")
    assert labels == ["[AI]-afk"]


def test_extra_labels_pass_through_asis():
    labels, _ = _labels("> ci\n\nbody")
    assert labels == ["ci"]
    labels, _ = _labels("> ci, mode:hitl\n\nbody")
    assert labels == ["ci", "[AI]-hitl"]
    labels, _ = _labels("> good-first-issue, difficulty:low\n\nbody")
    assert labels == ["good-first-issue", "[AI]-low-difficulty"]


def test_spec_line_maps_to_canonical_label():
    labels, body = _labels("> spec\n\n## Problem\n")
    assert labels == ["[AI]-spec"]
    assert body == "## Problem"

def test_whitespace_and_case_tolerance():
    labels, _ = _labels("  > Difficulty:Medium , MODE:hitl \n\nbody")
    assert labels == ["[AI]-medium-difficulty", "[AI]-hitl"]


def test_blank_lines_before_label_line_are_skipped():
    labels, _ = _labels("\n\n> mode:afk\n\nbody")
    assert labels == ["[AI]-afk"]


def test_malformed_lines_yield_no_labels_and_keep_body():
    # A ">" line that isn't a clean label list is left in the body, so it
    # gets skipped instead of being published with silently-partial labels.
    for bad in [
        "> ci, mode:",            # second token isn't a label
        "> mode:hitl, ",          # trailing comma / empty token
        "> some prose line",      # spaces inside a token
        "> mode:hitl and more",   # prose bolted onto a label
        "> # comment",            # header-ish
    ]:
        labels, body = _labels(f"{bad}\n\nrest\n")
        assert labels == [], bad
        assert body.startswith(bad), bad


def test_unknown_difficulty_value_is_treated_as_extra_label():
    # "difficulty:extreme" isn't an alias; it passes through verbatim so a
    # dry run shows it and a real publish lets gh be the authority.
    labels, _ = _labels("> difficulty:medium, difficulty:extreme\n\nbody")
    assert labels == ["[AI]-medium-difficulty", "difficulty:extreme"]


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

    def fake_create(title, body, labels):
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
    assert not (batch / ".published").exists()
    # The label line is stripped from the body that gets posted.
    assert "mode:afk" not in created[0][1]


def test_failed_draft_keeps_resolved_references_after_success(tmp_path, monkeypatch):
    def fake_create(title, body, labels):
        assert title == "First"
        return True, "https://github.com/x/y/issues/42"

    monkeypatch.setattr(hook, "gh_create_issue", fake_create)
    batch = tmp_path / ".issues-gateway" / SID
    batch.mkdir(parents=True)
    (batch / "issue-0.md").write_text(
        "# First\n\n> mode:afk\n\nBody\n", encoding="utf-8"
    )
    (batch / "issue-1.md").write_text(
        f"# Second\n\n## Body\n\nBlocked by {{{SID}/0}}\n", encoding="utf-8"
    )

    report: list[str] = []
    count, failures = hook.publish_batch(batch, dry=False, report=report)

    assert count == 1 and failures == 1
    assert not (batch / "issue-0.md").exists()
    assert not (batch / ".published").exists()
    assert "Blocked by #42" in (batch / "issue-1.md").read_text(encoding="utf-8")
    assert any("missing or malformed label line" in line for line in report)


def test_dry_run_reports_each_draft_with_labels(tmp_path):
    _draft(tmp_path, "issue-0.md", "# A\n\n> difficulty:low\n\nbody a\n")
    _draft(tmp_path, "issue-1.md", "# B\n\n> bug, mode:hitl\n\nbody b\n")
    report, count, failures = _dry_publish(tmp_path)
    assert count == 2 and failures == 0
    assert any('"A" [[AI]-low-difficulty]' in line for line in report)
    assert any('"B" [bug, [AI]-hitl]' in line for line in report)


def test_prompt_pattern_matches_with_or_without_dry():
    assert hook.PROMPT_PATTERN.match("/publish-issues")
    assert hook.PROMPT_PATTERN.match("/publish-issue")
    assert hook.PROMPT_PATTERN.match("/publish-issues --dry")
    assert not hook.PROMPT_PATTERN.match("/publish-issuesx")
    assert not hook.PROMPT_PATTERN.match("hello /publish-issues")
