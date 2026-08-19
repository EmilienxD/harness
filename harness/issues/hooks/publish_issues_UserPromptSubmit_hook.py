#!/usr/bin/env python3
"""UserPromptSubmit hook: publishes drafted GitHub issues from .issues-gateway/.

Fires before Claude ever sees the prompt. When the prompt is "/publish-issues"
or "/publish-issue" (optionally with "--dry"), this script does all the
work itself with `gh` and exits 2, which erases the prompt and shows stderr to
the user only - zero API calls for this step.

Design notes:
- Each batch lives in its own directory: ".issues-gateway/{session-id}/",
  where the session id is the Claude Code session id the drafting run had
  (${CLAUDE_SESSION_ID}). It is unique per session by construction, so no
  collision handling is needed.
- Draft files inside a batch dir are named "issue-{i}.md". Sorting by `i`
  gives a stable creation order, so an issue can only reference an issue
  created earlier in the same batch (no forward references), assuming
  /draft-issues emitted a correct topological order. This script no longer
  *assumes* that ordering is perfect - see the retry pass below.
- The first "# " header line in a draft file is the issue title. The first
  non-empty line after that declares labels (see /draft-issues, /draft-issue,
  /to-spec-draft-issue): either "> spec", or
  "> " followed by a comma-separated list of label tokens in any order -
  "difficulty:{level}" and "mode:{afk|hitl}" are each optional (the user can
  ask for them to be left off), and extra labels the user asked for may be
  added alongside (e.g. "> ci, difficulty:advanced"). Aliased tokens map to the
  workflow's own "[AI]-" prefixed label names ("[AI]-advanced-difficulty", "[AI]-afk",
  "[AI]-spec", ...) via LABEL_ALIASES, then are stripped from the body that
  gets posted, since the labels carry that information from then on. Extra
  (non-aliased) tokens pass through as-is - the drafting skills are
  responsible for checking with `gh label list` that they exist.
- A reference to another draft issue, written as plain text "{session-id}/{i}"
  in the body (no backticks, no braces - GitHub only autolinks a bare
  "#<number>", so the resolved replacement must not sit inside inline code),
  is rewritten to "#<real-issue-number>" once that draft has been published.
  This is how "blocked by" links get resolved without creating issues
  sequentially inside the agent loop.
- Once an issue is published, its draft file is deleted immediately. If a
  later draft cannot publish in the same run, any references that are already
  known are rewritten in that remaining draft before it is left in place, so
  a rerun does not need an archive of successful drafts to resolve them.
- Within a single run, unresolved references are retried in a worklist loop
  rather than skipped once and left for a manual rerun - this self-heals
  ordering mistakes (e.g. a diamond dependency the model numbered wrong)
  and only reports a failure for references that are still unresolved after
  every file that *could* make progress has been tried.
- The body is always passed to `gh` via --body-file (a temp file), never
  inline on the command line. This is what avoids the Windows command-line
  length limit, on every platform, regardless of body size.
- Every successful create is recorded in a per-batch ledger,
  ".issues-gateway/{session-id}/.published.json", keyed exactly like an
  in-body reference. Every ledger is seeded back into the resolver at the
  start of a run, so a reference to an issue published in an *earlier* run
  still resolves, and the ledger remembers which issue carried the
  "[AI]-spec" label so "{session-id}/spec" works as a parent reference.
- A "## Parent" section whose first non-empty line is a bare reference
  ("#42", an issue URL, "{session-id}/{i}", or "{session-id}/spec") makes
  the new issue a real GitHub sub-issue of that parent. Knowing the number
  is not enough: GitHub's sub-issue graph is structural, so the link is made
  with `gh issue create --parent` (or, on a gh too old for that flag, a
  follow-up `gh issue edit --parent`). The section is stripped from the
  posted body once the link is made, since GitHub renders the parent
  natively. Prose under "## Parent" is left exactly as written.
- Publishing runs with no model turn at all (exit 2 erases the prompt), so
  the agent would otherwise never learn the real issue numbers. Each run
  appends what it created to ".issues-gateway/.pending-notice.json"; the
  next prompt that isn't a publish command flushes that file into the
  model's context as `additionalContext` and deletes it. It is delivered
  exactly once, riding along with a prompt the user was sending anyway, so
  it costs no extra API call - and it lets the next drafting turn write a
  real "#42" under "## Parent".
- "--dry" runs the exact same parse/resolve logic but never calls
  `gh issue create`, never deletes files, never writes the ledger, and
  never queues a notice - it reports what would happen, so a bad label
  line or a genuinely unresolvable reference can be caught before anything
  touches the tracker.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

GATEWAY_DIR = Path(".issues-gateway")

# Per-batch record of what has already been published, so numbers survive
# both the deletion of the draft and the end of the run that created them.
LEDGER_NAME = ".published.json"

# Queue of published issues the agent has not been told about yet. Lives at
# the gateway root, not inside a batch dir, so a notice is delivered on the
# next prompt whatever session that prompt belongs to (a /clear between the
# publish and the next prompt must not strand it).
NOTICE_NAME = ".pending-notice.json"

# Keeps a huge batch well under the 10,000-character cap on additionalContext.
MAX_NOTICE_ENTRIES = 50

# "/publish-issue", "/publish-issues", and their "--dry" variants match.
PROMPT_PATTERN = re.compile(r"^/publish-issues?(?:\s|$)")

# A batch directory name: a Claude Code session id (a UUID).
SESSION_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# A reference to another draft issue inside a body, written as plain text:
# "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/0"
# Matching the full UUID keeps the pattern unambiguous without needing
# wrappers like "{...}", and the session id must appear verbatim in the
# draft anyway for the reference to point at the right batch.
REF_PATTERN = re.compile(
    r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(\d+)\b"
)

# "{session-id}/spec": the issue published from this session that carried the
# "[AI]-spec" label. Lets a batch declare the spec as its parent without
# anyone - model or user - having to know the real issue number.
SPEC_REF_PATTERN = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/spec$"
)

# The "## Parent" section (any heading level) and the reference forms allowed
# as its first non-empty line.
HEADING_PATTERN = re.compile(r"^\s*#{1,6}\s+\S")
PARENT_HEADING_PATTERN = re.compile(r"^\s*#{1,6}\s+parent\s*$", re.IGNORECASE)
PARENT_NUMBER_PATTERN = re.compile(r"^#?(\d+)$")
PARENT_URL_PATTERN = re.compile(r"^<?https?://\S+?/issues/(\d+)/?>?$", re.IGNORECASE)
PARENT_NONE_PATTERN = re.compile(r"^(none|n/a)\.?$", re.IGNORECASE)

# The draft filename convention produced by /draft-issues: "issue-{i}.md"
FILENAME_PATTERN = re.compile(r"^issue-(\d+)\.md$")

# The label declaration line produced by /draft-issues or /draft-issue: a
# comma-separated list of label tokens in any order, with "difficulty:*" and
# "mode:*" each optional and extra labels allowed, e.g.
# "> difficulty:advanced, mode:hitl", "> mode:afk", "> ci, difficulty:basic".
# Tolerant of leading whitespace before the ">" and of surrounding spaces
# around tokens and commas.
_LABEL_TOKEN = r"[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?"
LABEL_LINE_PATTERN = re.compile(
    rf"^\s*>(?:\s*{_LABEL_TOKEN}\s*,)*\s*{_LABEL_TOKEN}\s*$",
    re.IGNORECASE,
)

# The label declaration line produced by /to-spec-draft-issue ("> spec").
SPEC_LABEL_LINE_PATTERN = re.compile(r"^\s*>\s*spec\s*$", re.IGNORECASE)

# Canonical labels this workflow depends on: (color, description). They carry
# an "[AI]-" prefix so they can't collide with a repo's own labels, and so the
# same labels can be shared across projects that use this tool as a dependency.
# They are created at the start of every publish run if missing; existing ones
# are left alone, so the user's own styling is never overwritten.
CANONICAL_LABELS = {
    "[AI]-routine-difficulty": ("0E8A16", "Low reasoning level work - use rarely."),
    "[AI]-basic-difficulty": ("FBCA04", "Easy, small refactors, missing tests, or documentation."),
    "[AI]-advanced-difficulty": ("D93F0B", "Multi-step work with expected outcomes and low bug risk."),
    "[AI]-expert-difficulty": ("B60205", "Complex, judgment-heavy, wide-context, or bug-prone work."),
    "[AI]-afk": ("1D76DB", "Safe to implement in one shot, no review needed before landing."),
    "[AI]-hitl": ("5319E7", "Sensitive, design-touching, or complex - needs human review."),
    "[AI]-spec": ("7057FF", "A product spec synthesized from conversation."),
}

# The declaration line uses "difficulty:{level}" / "mode:{mode}" tokens; the
# labels actually created and applied are the names above. Any other token on
# the line is applied as-is (the drafting skills check those exist with
# `gh label list` before writing them).
LABEL_ALIASES = {
    "difficulty:routine": "[AI]-routine-difficulty",
    "difficulty:basic": "[AI]-basic-difficulty",
    "difficulty:advanced": "[AI]-advanced-difficulty",
    "difficulty:expert": "[AI]-expert-difficulty",
    "mode:afk": "[AI]-afk",
    "mode:hitl": "[AI]-hitl",
    "spec": "[AI]-spec",
}


def load_ledger(batch_dir: Path) -> dict:
    """Read a batch's record of already-published issues, or {}.

    A corrupt or hand-mangled ledger must never block publishing, so any
    read error degrades to "nothing is known yet" rather than raising.
    """
    path = batch_dir / LEDGER_NAME
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def record_published(batch_dir: Path, key: str, entry: dict) -> None:
    """Append one published issue to the batch ledger, immediately.

    Written after every single create rather than once at the end of the
    run, so an interrupted batch still leaves behind the numbers it did
    create - that is what a rerun needs to resolve references to them.
    """
    ledger = load_ledger(batch_dir)
    ledger[key] = entry
    try:
        (batch_dir / LEDGER_NAME).write_text(
            json.dumps(ledger, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass  # the issue exists on the tracker; a missing ledger is not fatal


def seed_from_ledgers(batch_dirs: list[Path]) -> tuple[dict[str, str], dict[str, str]]:
    """Build (resolved, specs) from every batch ledger on disk.

    resolved maps "{session-id}/{i}" -> issue number, exactly like the
    in-run map. specs maps "{session-id}" -> the number of the issue that
    session published with the spec label. Both are merged across batches
    because reference keys carry their own session id and so are unique.
    """
    resolved: dict[str, str] = {}
    specs: dict[str, str] = {}
    for batch_dir in batch_dirs:
        for key, entry in load_ledger(batch_dir).items():
            if not isinstance(entry, dict):
                continue
            number = entry.get("number")
            if not number:
                continue
            resolved[key] = str(number)
            if entry.get("spec"):
                specs[key.split("/", 1)[0]] = str(number)
    return resolved, specs


def queue_notice(created: list[dict], failed: int, gateway_dir: Path = GATEWAY_DIR) -> None:
    """Stage what this run published for delivery on the next prompt.

    Appends rather than overwrites: two publish runs in a row (the second
    prompt is another /publish-issues, so nothing was flushed in between)
    must both reach the agent.
    """
    if not created and not failed:
        return
    path = gateway_dir / NOTICE_NAME
    pending = {"created": [], "failed": 0}
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                if isinstance(existing.get("created"), list):
                    pending["created"] = existing["created"]
                if isinstance(existing.get("failed"), int):
                    pending["failed"] = existing["failed"]
        except (OSError, ValueError):
            pass
    pending["created"].extend(created)
    pending["failed"] += failed
    try:
        path.write_text(json.dumps(pending, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def format_notice(created: list[dict], failed: int) -> str:
    """The text injected into the agent's context on the next prompt."""
    lines = [
        "/publish-issues ran just before this message. It is a hook, so it "
        "produced no assistant turn - this is how you learn what happened."
    ]
    if created:
        lines.append("")
        lines.append("These GitHub issues now exist on the tracker:")
        for entry in created[:MAX_NOTICE_ENTRIES]:
            labels = ", ".join(entry.get("labels") or []) or "no labels"
            title = entry.get("title") or "(untitled)"
            lines.append(f"- #{entry.get('number')} \"{title}\" [{labels}]")
        remaining = len(created) - MAX_NOTICE_ENTRIES
        if remaining > 0:
            lines.append(f"- ... and {remaining} more")
    if failed:
        lines.append("")
        lines.append(
            f"{failed} draft(s) failed or were skipped and are still in "
            ".issues-gateway/ awaiting a rerun."
        )
    lines.append("")
    if created:
        lines.append(
            "Refer to these issues by their real numbers from now on. A new draft "
            "becomes a GitHub sub-issue of one of them when a bare reference (e.g. "
            f"#{created[0].get('number')}) is the first non-empty line under its "
            "\"## Parent\" heading - /publish-issues turns that into a real "
            "sub-issue link."
        )
        lines.append(
            "Do not re-draft, re-publish, close, or otherwise modify issues that "
            "already exist."
        )
    else:
        lines.append("Rerun /publish-issues once those drafts are fixed.")
    return "\n".join(lines)


def flush_notice(gateway_dir: Path = GATEWAY_DIR) -> str | None:
    """Consume the pending notice, if any. Delivered exactly once."""
    path = gateway_dir / NOTICE_NAME
    if not path.is_file():
        return None
    try:
        pending = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pending = None
    try:
        path.unlink()
    except OSError:
        pass
    if not isinstance(pending, dict):
        return None
    created = pending.get("created")
    created = created if isinstance(created, list) else []
    failed = pending.get("failed")
    failed = failed if isinstance(failed, int) else 0
    if not created and not failed:
        return None
    return format_notice(created, failed)


def ensure_labels(dry: bool) -> list[str]:
    """Create the canonical labels that are missing; never touch existing ones.

    "gh label create" exits non-zero with an "already exists" error when the
    label is present, so a plain create is create-only: an existing label's
    color and description are left exactly as the user has them."""
    if dry:
        return []

    warnings = []
    for name, (color, description) in CANONICAL_LABELS.items():
        result = subprocess.run(
            [
                "gh", "label", "create", name,
                "--color", color,
                "--description", description,
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 and "already exists" in (result.stderr or result.stdout):
            continue  # already there - leave it untouched
        if result.returncode != 0:
            warnings.append(
                f"  WARN  could not ensure label '{name}': "
                f"{(result.stderr or result.stdout).strip()}"
            )
    return warnings


def parse_issue_file(path: Path) -> tuple[str, str]:
    """Split a draft file into (title, rest). Title = first '# ' header."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    title = None
    rest_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            rest_start = i + 1
        break
    if title is None:
        title = path.stem
    rest = "\n".join(lines[rest_start:])
    return title, rest


def extract_labels(rest: str) -> tuple[list[str], str]:
    """Pull the label declaration line out of the body.

    Accepts either "> spec" (one label) or
    "> " followed by a comma-separated
    list of label tokens in any order - "difficulty:*" and "mode:*" are each
    optional, and extra labels pass through as-is. Returns (labels,
    remaining_body). labels is empty if the line is missing or malformed
    (e.g. a ">" quote, or a list carrying a token that can't be a label -
    the whole line is left in the body untouched rather than silently
    applying a partial set of labels).
    """
    lines = rest.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines):
        if SPEC_LABEL_LINE_PATTERN.match(lines[idx]):
            remaining = "\n".join(lines[idx + 1:]).strip()
            return [LABEL_ALIASES["spec"]], remaining
        if LABEL_LINE_PATTERN.match(lines[idx]):
            content = lines[idx].strip()[1:]  # drop the leading ">"
            labels = []
            for token in content.split(","):
                name = LABEL_ALIASES.get(token.strip().lower(), token.strip())
                if name not in labels:
                    labels.append(name)
            if labels:
                remaining = "\n".join(lines[idx + 1:]).strip()
                return labels, remaining
    return [], rest.strip()


def parse_parent_ref(text: str) -> str | None:
    """Recognize the reference forms allowed under "## Parent".

    Returns a bare issue number for a direct reference ("#42", a URL), the
    "{session-id}/{i}" or "{session-id}/spec" token for a reference that
    still needs resolving, or None for anything else - prose under that
    heading is a description, not a link, and must be left alone.
    """
    text = text.strip()
    match = PARENT_URL_PATTERN.match(text)
    if match:
        return match.group(1)
    match = REF_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    match = SPEC_REF_PATTERN.match(text)
    if match:
        return f"{match.group(1)}/spec"
    match = PARENT_NUMBER_PATTERN.match(text)
    if match:
        return match.group(1)
    return None


def extract_parent(body: str) -> tuple[str | None, str]:
    """Pull a parent reference out of the body's "## Parent" section.

    Returns (reference, remaining_body). The section is removed only when
    its first non-empty line is a reference (or an explicit "none"), since
    that is the case where the information moves into GitHub's own sub-issue
    link and repeating it in the body adds nothing. A section holding prose
    - including the template's own placeholder text - is left untouched and
    yields no parent.
    """
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        if not PARENT_HEADING_PATTERN.match(line):
            continue

        ref_idx = idx + 1
        while ref_idx < len(lines) and not lines[ref_idx].strip():
            ref_idx += 1
        if ref_idx >= len(lines):
            return None, body

        candidate = lines[ref_idx].strip()
        explicit_none = bool(PARENT_NONE_PATTERN.match(candidate))
        ref = None if explicit_none else parse_parent_ref(candidate)
        if ref is None and not explicit_none:
            return None, body

        end = ref_idx + 1
        while end < len(lines) and not HEADING_PATTERN.match(lines[end]):
            end += 1
        remaining = "\n".join(lines[:idx] + lines[end:])
        return ref, remaining.strip("\n")
    return None, body


def resolve_parent(
    ref: str, resolved: dict[str, str], specs: dict[str, str]
) -> tuple[str | None, bool]:
    """Turn a parent reference into an issue number.

    Returns (number, retryable). A direct "#42" always resolves; a session
    reference resolves once the issue it points at has been published, and
    is retryable until then - the spec may simply be later in this same run.
    """
    if ref.isdigit():
        return ref, False
    if ref.endswith("/spec"):
        number = specs.get(ref[: -len("/spec")])
        return number, number is None
    number = resolved.get(ref)
    return number, number is None


def resolve_references(body: str, resolved: dict[str, str]) -> tuple[str, list[str]]:
    """Replace plain-text session-id/{i} tokens with real issue numbers.

    Returns the rewritten body and any tokens that could not be resolved
    (e.g. a forward reference to a draft not yet published in this run).
    """
    unresolved: list[str] = []

    def _sub(match: re.Match) -> str:
        key = f"{match.group(1)}/{match.group(2)}"
        if key in resolved:
            return f"#{resolved[key]}"
        unresolved.append(key)
        return match.group(0)

    return REF_PATTERN.sub(_sub, body), unresolved


def gather_batch_dirs() -> list[Path]:
    """List batch directories under the gateway dir, sorted by name."""
    if not GATEWAY_DIR.is_dir():
        return []
    return sorted(
        d for d in GATEWAY_DIR.iterdir()
        if d.is_dir() and SESSION_ID_PATTERN.match(d.name)
    )


def gather_draft_files(batch_dir: Path) -> list[Path]:
    """List draft files in a batch, in stable, dependency-safe order."""
    ordered = []
    for path in batch_dir.glob("*.md"):
        m = FILENAME_PATTERN.match(path.name)
        if not m:
            continue  # e.g. stray files, not drafts
        ordered.append((int(m.group(1)), path))
    ordered.sort(key=lambda t: t[0])
    return [p for _, p in ordered]


def rewrite_known_references(path: Path, resolved: dict[str, str]) -> None:
    """Persist any known reference rewrites in a draft that remains pending."""
    if not resolved:
        return

    text = path.read_text(encoding="utf-8")

    def _sub(match: re.Match) -> str:
        key = f"{match.group(1)}/{match.group(2)}"
        if key in resolved:
            return f"#{resolved[key]}"
        return match.group(0)

    rewritten = REF_PATTERN.sub(_sub, text)
    if rewritten != text:
        path.write_text(rewritten, encoding="utf-8")


def delete_published_draft(path: Path) -> None:
    """Remove a draft after gh confirms the issue exists."""
    path.unlink()


_parent_flag_supported: bool | None = None


def parent_flag_supported() -> bool:
    """Whether this gh can create a sub-issue in one call.

    `gh issue create --parent` landed relatively recently; on an older gh the
    same link is made afterwards with `gh issue edit --parent`. Probed once
    per run, and only when a draft actually declares a parent.
    """
    global _parent_flag_supported
    if _parent_flag_supported is None:
        try:
            result = subprocess.run(
                ["gh", "issue", "create", "--help"], capture_output=True, text=True
            )
            _parent_flag_supported = "--parent" in (
                (result.stdout or "") + (result.stderr or "")
            )
        except OSError:
            _parent_flag_supported = False
    return _parent_flag_supported


def gh_link_parent(child: str, parent: str) -> tuple[bool, str]:
    """Attach an existing issue to a parent (the older-gh fallback path)."""
    result = subprocess.run(
        ["gh", "issue", "edit", child, "--parent", parent],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    return True, ""


def gh_create_issue(
    title: str, body: str, labels: list[str], parent: str | None = None
) -> tuple[bool, str]:
    """Create one issue with gh. Body always goes through --body-file."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(body)
        tmp_path = tmp.name

    args = ["gh", "issue", "create", "--title", title, "--body-file", tmp_path]
    for label in labels:
        args += ["--label", label]
    if parent and parent_flag_supported():
        args += ["--parent", parent]

    try:
        result = subprocess.run(args, capture_output=True, text=True)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()

    stdout = result.stdout.strip()
    url = stdout.splitlines()[-1] if stdout else ""
    return True, url


def publish_batch(
    batch_dir: Path,
    dry: bool,
    report: list[str],
    created: list[dict] | None = None,
    seed: tuple[dict[str, str], dict[str, str]] | None = None,
) -> tuple[int, int]:
    """Publish (or dry-run) every draft file in one batch directory.

    `created` collects one record per published issue, for the ledger and
    for the notice delivered to the agent on the next prompt. `seed` is the
    (resolved, specs) pair built from ledgers on disk; when omitted, only
    this batch's own ledger is consulted, so references to issues published
    in an earlier run still resolve.

    Returns (published_count, failed_count) for this batch.
    """
    files = gather_draft_files(batch_dir)
    if not files:
        return 0, 0

    resolved, specs = seed if seed is not None else seed_from_ledgers([batch_dir])
    resolved = dict(resolved)
    specs = dict(specs)
    batch_header = f"Batch: {len(files)} draft issue(s)"
    report.append(batch_header)
    report.append("")

    # Worklist retry: a file with an unresolved reference goes back on the
    # queue instead of being skipped permanently, so ordering mistakes
    # (e.g. a diamond dependency numbered out of order) self-heal within
    # this run. Bounded to len(files) passes - a true cycle or a reference
    # to something outside the batch will still be unresolved after that
    # many attempts and gets reported as a real failure.
    pending = files
    published = 0
    failed_entries: list[str] = []

    for _ in range(max(len(files), 1)):
        if not pending:
            break
        still_pending = []
        made_progress = False

        for path in pending:
            title, rest = parse_issue_file(path)
            labels, body_with_refs = extract_labels(rest)

            if not labels:
                if not dry:
                    rewrite_known_references(path, resolved)
                failed_entries.append(
                    f"  SKIP  {path.name} - missing or malformed label line"
                )
                made_progress = True  # not retryable, don't requeue
                continue

            body_keeping_parent = body_with_refs
            parent_ref, body_with_refs = extract_parent(body_with_refs)
            parent_number = None
            if parent_ref:
                parent_number, retryable = resolve_parent(parent_ref, resolved, specs)
                if parent_number is None and retryable:
                    # The parent may simply be published later in this run
                    # (a spec drafted alongside the issues that hang off it).
                    if not dry:
                        rewrite_known_references(path, resolved)
                    still_pending.append(path)
                    continue

            body, unresolved = resolve_references(body_with_refs, resolved)
            if unresolved:
                if not dry:
                    rewrite_known_references(path, resolved)
                still_pending.append(path)
                continue

            m = FILENAME_PATTERN.match(path.name)
            if not m:
                continue
            i = m.group(1)
            key = f"{batch_dir.name}/{i}"
            is_spec = LABEL_ALIASES["spec"] in labels

            if dry:
                suffix = f" -> sub-issue of #{parent_number}" if parent_number else ""
                report.append(
                    f"  Would create: \"{title}\" [{', '.join(labels)}]{suffix}"
                )
                # Fabricate a placeholder so later dry-run references in
                # this batch resolve too, for a fuller preview.
                resolved[key] = f"NEW-{i}"
                if is_spec:
                    specs[batch_dir.name] = f"NEW-{i}"
                published += 1
                made_progress = True
                continue

            # On a gh without `--parent`, the reference stays in the posted
            # body as a fallback, since the follow-up link can still fail.
            keep_parent_in_body = bool(parent_number) and not parent_flag_supported()
            if keep_parent_in_body:
                body, _ = resolve_references(body_keeping_parent, resolved)

            ok, info = gh_create_issue(title, body, labels, parent_number)
            if ok:
                number_match = re.search(r"/issues/(\d+)", info)
                resolved_number = number_match.group(1) if number_match else "?"
                resolved[key] = resolved_number
                if is_spec:
                    specs[batch_dir.name] = resolved_number
                report.append(f"  Created: {info}")
                linked_parent = parent_number
                if parent_number and keep_parent_in_body:
                    linked, err = gh_link_parent(resolved_number, parent_number)
                    if not linked:
                        # The issue exists and still names its parent in the
                        # body; only the structural link is missing.
                        linked_parent = None
                        report.append(
                            f"  WARN  #{resolved_number} created, but linking it "
                            f"under #{parent_number} failed: {err}"
                        )
                if linked_parent:
                    report.append(f"        sub-issue of #{linked_parent}")
                record = {
                    "number": resolved_number,
                    "url": info,
                    "title": title,
                    "labels": labels,
                    "spec": is_spec,
                    "parent": linked_parent,
                }
                record_published(batch_dir, key, record)
                if created is not None:
                    created.append(record)
                delete_published_draft(path)
                published += 1
            else:
                rewrite_known_references(path, resolved)
                failed_entries.append(f"  FAIL  {path.name}: {info}")
            made_progress = True

        pending = still_pending
        if not made_progress:
            break

    # Anything still pending after the retry loop is a genuine problem:
    # either a reference outside this batch, or a real dependency cycle.
    for path in pending:
        if not dry:
            rewrite_known_references(path, resolved)
        title, rest = parse_issue_file(path)
        _, body_with_refs = extract_labels(rest)
        parent_ref, body_with_refs = extract_parent(body_with_refs)
        _, unresolved = resolve_references(body_with_refs, resolved)
        if parent_ref and resolve_parent(parent_ref, resolved, specs)[0] is None:
            unresolved.append(f"parent {parent_ref}")
        failed_entries.append(
            f"  SKIP  {path.name} - unresolved reference: {', '.join(unresolved)}"
        )

    report.extend(failed_entries)
    return published, len(failed_entries)


def publish_issues(dry: bool) -> str:
    if not GATEWAY_DIR.is_dir():
        return "No .issues-gateway/ folder found. Run /draft-issue or /draft-issues first."

    batch_dirs = gather_batch_dirs()
    if not batch_dirs:
        return "No draft batches found in .issues-gateway/. Nothing to publish."

    header = "Dry run -- nothing will be created" if dry else "Publishing drafted issues"
    report = [header, ""]
    label_warnings = ensure_labels(dry)
    if label_warnings:
        report.extend(label_warnings)
        report.append("")

    # Ledgers from every batch are merged up front: reference keys carry
    # their own session id, so a draft can point at an issue another batch
    # published in an earlier run.
    seed = seed_from_ledgers(batch_dirs)

    total_published = 0
    total_failed = 0
    created: list[dict] = []
    for batch_dir in batch_dirs:
        p, f = publish_batch(batch_dir, dry, report, created, seed)
        total_published += p
        total_failed += f
        report.append("")

    if not dry:
        queue_notice(created, total_failed)

    if dry:
        report.append(
            f"Dry run complete: {total_published} issue(s) ready to publish."
        )
        if total_failed:
            report.append(f"{total_failed} would be skipped (see above).")
    elif total_failed:
        report.append(
            f"Published {total_published} issue(s). {total_failed} failed or were skipped."
        )
        report.append("Failed drafts remain in .issues-gateway/ -- fix and rerun.")
    else:
        report.append(f"Published {total_published} issue(s) successfully.")

    return "\n".join(report)


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()

    if PROMPT_PATTERN.match(prompt):
        dry = "--dry" in prompt.split()
        result = publish_issues(dry)
        sys.stderr.write("\n\n" + result)
        # Exit 2 erases the prompt, so this run produces no model turn at
        # all. Whatever it published stays queued until the next prompt.
        sys.exit(2)

    # Any other prompt is the first chance the agent has to be told what the
    # last publish run created. This hook sees every prompt in the session,
    # so it must never fail one: a broken notice is dropped, not raised.
    try:
        notice = flush_notice()
    except Exception:  # noqa: BLE001 - never block a prompt over a notice
        notice = None

    if notice:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": notice,
                }
            },
            sys.stdout,
        )

    sys.exit(0)


if __name__ == "__main__":
    main()
