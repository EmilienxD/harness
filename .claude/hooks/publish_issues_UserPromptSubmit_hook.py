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
  /to-spec-draft-issue): "> " followed by a comma-separated list of label
  tokens in any order. Every draft uses this same format - a spec is just a
  draft whose tokens include "spec" (mandatory for /to-spec-draft-issue
  output, alongside any extra labels, e.g. "> spec, security").
  "difficulty:{level}" and "mode:{afk|hitl}" are each optional (the user can
  ask for them to be left off), and extra labels the user asked for may be
  added alongside (e.g. "> ci, difficulty:advanced"). Aliased tokens map to the
  workflow's own "[AI]-" prefixed label names ("[AI]-advanced-difficulty",
  "[AI]-afk", "[AI]-spec", ...) via LABEL_ALIASES, then are stripped from the
  body that gets posted, since the labels carry that information from then
  on. Extra (non-aliased) tokens pass through as-is - multi-word tokens are
  fine ("good first issue" is a standard GitHub label) - and the drafting
  skills are responsible for checking with `gh label list` that they exist.
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
- Every successful create is recorded in the shared state file,
  ".issues-gateway/.state.json", under "published", keyed exactly like an
  in-body reference. It is seeded back into the resolver at the start of a
  run, so a reference to an issue published in an *earlier* run still
  resolves. Reads and writes of the state file run under a portalocker lock
  (falling back to no lock when portalocker is unavailable), so two
  concurrent Claude Code sessions publishing in the same project cannot
  lose each other's entries; the loser of the race gets a warning in the
  report instead of clobbered state.
- A "## Parent" section whose first non-empty line is a bare reference
  ("#42", an issue URL, or "{session-id}/{i}" - the same token used under
  "Blocked by") makes the new issue a real GitHub sub-issue of that parent.
  Parents are structural, not label-based: any draft can be a parent.
  Knowing the number
  is not enough: GitHub's sub-issue graph is structural, so the link is made
  with `gh issue create --parent` (or, on a gh too old for that flag, a
  follow-up `gh issue edit --parent`). The section is stripped from the
  posted body once the link is made, since GitHub renders the parent
  natively. Prose under "## Parent" is left exactly as written.
- Publishing runs with no model turn at all (exit 2 erases the prompt), so
  the agent would otherwise never learn the real issue numbers. Each run
  appends what it created to the "pending_notice" section of the shared state
  file; the next prompt that isn't a publish command flushes that section
  into the model's context as `additionalContext` and clears it. It is
  delivered exactly once, riding along with a prompt the user was sending
  anyway, so it costs no extra API call - and it lets the next drafting turn
  write a real "#42" under "## Parent".
- "--dry" runs the exact same parse/resolve/chunk-count logic but never invokes
  `gh`, never deletes files, never writes state, and
  never queues a notice - it reports what would happen, so a bad label
  line or a genuinely unresolvable reference can be caught before anything
  touches the tracker.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# The shared state is read and written by any session publishing in the
# same project, so every read-modify-write cycle runs under a file lock
# (same pattern as src/harness_cli): portalocker when installed, no lock
# otherwise - the fallback loses cross-session safety but never the hook.
with contextlib.suppress(ImportError):
    import portalocker

GATEWAY_DIR = Path(".issues-gateway")

# One state file for the whole project, at the gateway root. "published" is
# durable reference resolution state; "pending_notice" is transient context
# delivery state that is cleared after the next non-publish prompt.
STATE_NAME = ".state.json"

# Sidecar carrying the state file's lock. Keystone of the concurrency story:
# never replaced or renamed, so a lock on it always names the same file,
# unlike the state file itself.
LOCK_NAME = ".state.lock"

# Legacy files from versions before the state file was consolidated. They are
# read as migration inputs only.
LEGACY_LEDGER_NAME = ".published.json"
LEGACY_NOTICE_NAME = ".pending-notice.json"

# Keeps a huge batch well under the 10,000-character cap on additionalContext.
MAX_NOTICE_ENTRIES = 50

# GitHub applies the same character limit to issue bodies and comments. Keep
# continuation payloads comfortably below it so generated headings, retry
# markers, and fence repairs can never push a post over the service limit.
GITHUB_BODY_LIMIT = 65_536
CHUNK_TARGET = 60_000

FENCE_PATTERN = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
ISSUE_MARKER_PATTERN = re.compile(
    r"<!-- issues-gateway:(?P<key>[^:]+):sha256:(?P<digest>[0-9a-f]{64}):"
    r"part:(?P<part>\d+)/(?P<total>\d+) -->"
)

# "/publish-issue", "/publish-issues", and their "--dry" variants match.
PROMPT_PATTERN = re.compile(r"^/publish-issues?(?:\s|$)")

# A batch directory name: a Claude Code session id (a UUID).
SESSION_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# A reference to another draft issue, written as plain text
# "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/0" - in a body ("Blocked by") or under
# "## Parent". {i} is the target draft's filename index: one reference form
# for every draft, whatever its labels. Matching the full UUID keeps the
# pattern unambiguous without needing wrappers like "{...}", and the session
# id must appear verbatim in the draft anyway for the reference to point at
# the right batch.
REF_PATTERN = re.compile(
    r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(\d+)\b"
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

# The label declaration line every drafting skill produces - specs included:
# "> " followed by a comma-separated list of label tokens in any order, with
# "difficulty:*" and "mode:*" each optional and extra labels allowed, e.g.
# "> difficulty:advanced, mode:hitl", "> mode:afk", "> ci, difficulty:basic",
# "> spec, security". A token is one or more whitespace-separated words, each
# word carrying an optional ":suffix" (the "difficulty:*" / "mode:*" form), so
# multi-word extra labels like "good first issue" parse. Tolerant of leading
# whitespace before the ">" and of surrounding spaces around tokens and
# commas.
_LABEL_WORD = r"[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?"
_LABEL_TOKEN = rf"{_LABEL_WORD}(?:\s+{_LABEL_WORD})*"
LABEL_LINE_PATTERN = re.compile(
    rf"^\s*>(?:\s*{_LABEL_TOKEN}\s*,)*\s*{_LABEL_TOKEN}\s*$",
    re.IGNORECASE,
)

# Canonical labels this workflow depends on: (color, description). They carry
# an "[AI]-" prefix so they can't collide with a repo's own labels, and so the
# same labels can be shared across projects that use this tool as a dependency.
# They are created immediately before the run's first remote mutation if
# missing; an oversized publication reserves state first. Existing labels are
# left alone, so the user's own styling is never overwritten.
CANONICAL_LABELS = {
    "[AI]-routine-difficulty": (
        "0E8A16",
        "Low reasoning level work (renames, cleanups, missing type hints) - use rarely.",
    ),
    "[AI]-basic-difficulty": (
        "FBCA04",
        "Easy, small refactoring (splitting functions, updating a model or "
        "signature), adding missing tests, writing or updating documentation.",
    ),
    "[AI]-advanced-difficulty": (
        "D93F0B",
        "Multi-step work with expected outcomes, low chance of encountering "
        "bugs, easy UI design.",
    ),
    "[AI]-expert-difficulty": (
        "B60205",
        "Multi-step complex work: careful judgment, complex UI design, wide "
        "context, bug-prone.",
    ),
    "[AI]-afk": (
        "1D76DB",
        "The agent can be trusted to implement it in one shot with no review.",
    ),
    "[AI]-hitl": (
        "5319E7",
        "Sensitive, touches frontend or UI design, or complex enough that a "
        "human should review it before it lands.",
    ),
    "[AI]-chrome": (
        "4285F4",
        "Requires a real browser to test a design change end to end.",
    ),
    "[AI]-spec": ("7057FF", "A spec synthesized from conversation."),
}

# The declaration line uses the "difficulty:{level}" / "mode:{mode}" / "chrome"
# / "spec" tokens below; the labels actually created and applied are the names
# above.
# Any other token on the line is applied as-is (the drafting skills check
# those exist with `gh label list` before writing them).
LABEL_ALIASES = {
    "difficulty:routine": "[AI]-routine-difficulty",
    "difficulty:basic": "[AI]-basic-difficulty",
    "difficulty:advanced": "[AI]-advanced-difficulty",
    "difficulty:expert": "[AI]-expert-difficulty",
    "mode:afk": "[AI]-afk",
    "mode:hitl": "[AI]-hitl",
    "chrome": "[AI]-chrome",
    "spec": "[AI]-spec",
}


def _read_json_dict(path: Path) -> dict:
    """Best-effort read of a {str: object} JSON file. Never raises.

    Corrupt or hand-mangled state must never block publishing, so any
    read error degrades to "nothing is known yet".
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_dict(path: Path, data: dict) -> None:
    """Persist JSON via a sibling temp file, so a concurrent reader never
    sees a half-written document. The lock lives on a separate sidecar file,
    so renaming over the state file is never lock-blocked."""
    tmp = path.with_name(path.stem + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


@contextlib.contextmanager
def _locked_state(gateway_dir: Path = GATEWAY_DIR):
    """Yield (path, state) under the portalocker lock, or (None, {}).

    The lock is taken on a sidecar file, ".state.lock" - locking the state
    file itself would let Windows deny the state file's own atomic replace
    (leaving it empty) and truncate it on contention, and a POSIX fcntl lock
    would not survive the state file being unlinked by a replace. Failing to
    take the lock (another session holds it) never blocks publishing: the
    caller gets None and reports a warning when durable state cannot be
    updated.
    Read-modify-write happens entirely inside the lock, so two sessions
    publishing at once merge instead of one clobbering the other's entries.
    """
    path = gateway_dir / STATE_NAME
    if "portalocker" not in sys.modules:
        yield path, _read_state(gateway_dir)
        return
    lock_path = gateway_dir / LOCK_NAME
    try:
        lock_path.touch(exist_ok=True)
        with portalocker.Lock(
            str(lock_path), mode="a", timeout=10, fail_when_locked=True
        ):
            yield path, _read_state(gateway_dir)
    except (portalocker.exceptions.LockException, OSError):
        yield None, {}


def _read_state(gateway_dir: Path = GATEWAY_DIR) -> dict:
    """Read the consolidated state file, with best-effort legacy migration."""
    path = gateway_dir / STATE_NAME
    state = _read_json_dict(path)
    published = state.get("published")
    notice = state.get("pending_notice")
    inflight = state.get("inflight")

    if not isinstance(published, dict):
        published = _read_json_dict(gateway_dir / LEGACY_LEDGER_NAME)
    if not isinstance(notice, dict):
        notice = _read_json_dict(gateway_dir / LEGACY_NOTICE_NAME)
    if not isinstance(inflight, dict):
        inflight = {}
    else:
        # A hand-edited or older state file must not poison every publish.
        inflight = {
            key: value
            for key, value in inflight.items()
            if isinstance(key, str) and isinstance(value, dict)
        }

    state = {}
    if published:
        state["published"] = published
    if notice:
        state["pending_notice"] = notice
    if inflight:
        state["inflight"] = inflight
    return state


def _write_state(path: Path, state: dict) -> None:
    cleaned: dict = {}
    published = state.get("published")
    notice = state.get("pending_notice")
    inflight = state.get("inflight")
    if isinstance(published, dict) and published:
        cleaned["published"] = published
    if isinstance(notice, dict) and notice:
        cleaned["pending_notice"] = notice
    if isinstance(inflight, dict) and inflight:
        cleaned["inflight"] = {
            key: value
            for key, value in inflight.items()
            if isinstance(key, str) and isinstance(value, dict)
        }
    _write_json_dict(path, cleaned)


def record_published(key: str, entry: dict, gateway_dir: Path = GATEWAY_DIR) -> bool:
    """Append one published issue to the shared state, immediately.

    Written after every single create rather than once at the end of the
    run, so an interrupted batch still leaves behind the numbers it did
    create - that is what a rerun needs to resolve references to them.
    Returns False when the write could not happen (lock held by another
    session, or an OS error): the issue exists on the tracker, so a
    missing state entry is a warning, not a failure.
    """
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return False
        published = state.get("published")
        if not isinstance(published, dict):
            published = {}
        published[key] = entry
        state["published"] = published
        try:
            _write_state(path, state)
        except OSError:
            return False
    return True


def seed_from_state(gateway_dir: Path = GATEWAY_DIR) -> dict[str, str]:
    """Build the resolved map from the shared state on disk.

    Maps "{session-id}/{i}" -> issue number, exactly like the in-run map.
    Reference keys carry their own session id, so one flat file can hold
    every session's numbers without collisions.
    """
    resolved: dict[str, str] = {}
    with _locked_state(gateway_dir) as (_, state):
        published = state.get("published")
        if not isinstance(published, dict):
            published = {}
        for key, entry in published.items():
            if not isinstance(entry, dict):
                continue
            number = entry.get("number")
            if not number:
                continue
            resolved[key] = str(number)
    return resolved


def queue_notice(created: list[dict], failed: int, gateway_dir: Path = GATEWAY_DIR) -> None:
    """Stage what this run published for delivery on the next prompt.

    Appends rather than overwrites: two publish runs in a row (the second
    prompt is another /publish-issues, so nothing was flushed in between)
    must both reach the agent.
    """
    if not created and not failed:
        return
    pending = {"created": [], "failed": 0}
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return
        existing = state.get("pending_notice")
        if isinstance(existing, dict):
            if isinstance(existing.get("created"), list):
                pending["created"] = existing["created"]
            if isinstance(existing.get("failed"), int):
                pending["failed"] = existing["failed"]
        pending["created"].extend(created)
        pending["failed"] += failed
        state["pending_notice"] = pending
        try:
            _write_state(path, state)
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
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return None
        pending = state.pop("pending_notice", None)
        try:
            _write_state(path, state)
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

    One format covers every draft, specs included: "> " followed by a
    comma-separated list of label tokens in any order - "difficulty:*" and
    "mode:*" are each optional, "spec" marks a spec (and may sit alongside
    extra labels), and any other token passes through as-is. Returns (labels,
    remaining_body). labels is empty if the line is missing or malformed
    (e.g. a ">" quote, or a list carrying a token that can't be a label -
    the whole line is left in the body untouched rather than silently
    applying a partial set of labels).
    """
    lines = rest.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and LABEL_LINE_PATTERN.match(lines[idx]):
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
    "{session-id}/{i}" token for a reference that still needs resolving, or
    None for anything else - prose under that heading is a description, not
    a link, and must be left alone.
    """
    text = text.strip()
    match = PARENT_URL_PATTERN.match(text)
    if match:
        return match.group(1)
    match = REF_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
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


def resolve_parent(ref: str, resolved: dict[str, str]) -> tuple[str | None, bool]:
    """Turn a parent reference into an issue number.

    Returns (number, retryable). A direct "#42" always resolves; a session
    reference resolves once the issue it points at has been published, and
    is retryable until then - the parent may simply be later in this same
    run, whichever draft it is.
    """
    if ref.isdigit():
        return ref, False
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


def gather_batch_dirs(gateway_dir: Path = GATEWAY_DIR) -> list[Path]:
    """List batch directories under the gateway dir, sorted by name."""
    if not gateway_dir.is_dir():
        return []
    return sorted(
        d for d in gateway_dir.iterdir()
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


def _fence_at(text: str, end: int) -> tuple[str, str] | None:
    """Return (reopen line, closing delimiter) when *end* is inside a fence."""
    active: tuple[str, str] | None = None
    for line in text[:end].splitlines():
        match = FENCE_PATTERN.match(line)
        if not match:
            continue
        delimiter, info = match.groups()
        if active is None:
            active = (delimiter + info, delimiter[0] * len(delimiter))
        elif delimiter[0] == active[1][0] and len(delimiter) >= len(active[1]):
            active = None
    return active


def _split_position(text: str, limit: int) -> int:
    """Choose a Markdown-friendly boundary no later than *limit*."""
    window = text[: limit + 1]
    paragraphs = [m.end() for m in re.finditer(r"\n[ \t]*\n", window)]
    lines = [m.end() for m in re.finditer(r"\n", window)]
    wanted = set(paragraphs) | set(lines)
    outside: set[int] = set()
    active: tuple[str, str] | None = None
    offset = 0
    for raw_line in window.splitlines(keepends=True):
        line = raw_line.rstrip("\r\n")
        match = FENCE_PATTERN.match(line)
        if match:
            delimiter, info = match.groups()
            if active is None:
                active = (delimiter + info, delimiter[0] * len(delimiter))
            elif delimiter[0] == active[1][0] and len(delimiter) >= len(active[1]):
                active = None
        offset += len(raw_line)
        if offset in wanted and active is None:
            outside.add(offset)
    for candidates in (paragraphs, lines):
        usable = [position for position in candidates if position in outside]
        if usable:
            return usable[-1]
    for candidates in (paragraphs, lines):
        if candidates:
            return candidates[-1]
    return min(limit, len(text))


def chunk_markdown(body: str, limit: int) -> list[str]:
    """Split Markdown deterministically, repairing fences only when necessary."""
    if len(body) <= limit:
        return [body]
    chunks: list[str] = []
    remaining = body
    while len(remaining) > limit:
        original = remaining
        cut = _split_position(remaining, limit)
        fence = _fence_at(remaining, cut)
        if fence:
            reopen, close = fence
            # Leave room for the newline and closing delimiter added below.
            repair_cost = len(close) + 1
            if cut + repair_cost > limit:
                cut = _split_position(remaining, limit - repair_cost)
                fence = _fence_at(remaining, cut)
            if fence:
                reopen, close = fence
                before, after = remaining[:cut], remaining[cut:]
                separator = "" if before.endswith("\n") else "\n"
                piece = before + separator + close
                remaining = reopen + "\n" + after
            else:
                piece = remaining[:cut]
                remaining = remaining[cut:]
        else:
            piece = remaining[:cut]
            remaining = remaining[cut:]
        if not piece or len(piece) > limit:
            # Defensive progress guarantee for pathological delimiters/limits.
            piece, remaining = original[:limit], original[limit:]
        chunks.append(piece)
    chunks.append(remaining)
    return chunks


def content_digest(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def part_marker(key: str, digest: str, part: int, total: int) -> str:
    return (
        f"<!-- issues-gateway:{key}:sha256:{digest}:"
        f"part:{part}/{total} -->"
    )


def render_oversized_parts(body: str, key: str) -> list[str]:
    """Render an oversized body as one issue body plus continuation comments."""
    digest = content_digest(body)
    # 512 comfortably covers headings and markers even for very large counts.
    content_limit = CHUNK_TARGET - 512
    while True:
        chunks = chunk_markdown(body, content_limit)
        total = len(chunks)
        rendered = []
        for index, chunk in enumerate(chunks, 1):
            marker = part_marker(key, digest, index, total)
            if index == 1:
                heading = (
                    f"> **Part 1 of {total}.** The remaining parts follow in "
                    "continuation comments."
                )
            else:
                heading = f"## Continuation — Part {index} of {total}"
            rendered.append(f"{heading}\n\n{chunk}\n\n{marker}")
        largest = max(map(len, rendered))
        if largest <= CHUNK_TARGET:
            if any(len(payload) > GITHUB_BODY_LIMIT for payload in rendered):
                raise ValueError("rendered issue part exceeds GitHub's body limit")
            return rendered
        content_limit -= largest - CHUNK_TARGET + 16
        if content_limit <= 0:
            raise ValueError("generated continuation metadata exceeds payload target")


def publication_fingerprint(
    repository: str, title: str, labels: list[str], parent: str | None, body: str
) -> str:
    data = {
        "repository": repository,
        "title": title,
        "labels": labels,
        "parent": parent,
        "body": body,
    }
    encoded = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _run_with_body_file(args: list[str], body: str) -> subprocess.CompletedProcess:
    """Run gh with a UTF-8 temporary body file whose newlines stay LF on Windows."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8", newline="\n"
    ) as tmp:
        tmp.write(body)
        tmp_path = tmp.name
    try:
        return subprocess.run(
            [*args, "--body-file", tmp_path], capture_output=True, text=True
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def gh_create_issue(
    title: str, body: str, labels: list[str], parent: str | None = None
) -> tuple[bool, str]:
    """Create one issue with gh. Body always goes through --body-file."""
    args = ["gh", "issue", "create", "--title", title]
    for label in labels:
        args += ["--label", label]
    if parent and parent_flag_supported():
        args += ["--parent", parent]

    result = _run_with_body_file(args, body)

    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()

    stdout = result.stdout.strip()
    url = stdout.splitlines()[-1] if stdout else ""
    return True, url


def gh_comment_issue(issue_url: str, body: str) -> tuple[bool, str]:
    result = _run_with_body_file(["gh", "issue", "comment", issue_url], body)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    return True, (result.stdout or "").strip()


def gh_repository() -> tuple[bool, str]:
    result = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    return True, result.stdout.strip()


def _gh_json(args: list[str]) -> tuple[bool, list[dict] | str]:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    try:
        data = json.loads(result.stdout or "[]")
    except ValueError:
        return False, "gh returned malformed JSON"
    if not isinstance(data, list):
        return False, "gh returned an unexpected JSON shape"
    return True, data


def gh_find_reserved_issue(
    repository: str, started_at: str, marker: str
) -> tuple[bool, dict | None | str]:
    date = started_at[:10]
    ok, data = _gh_json(
        [
            "gh", "issue", "list", "--repo", repository, "--state", "all",
            "--limit", "1000", "--search", f"created:>={date}",
            "--json", "number,url,body,createdAt",
        ]
    )
    if not ok:
        return False, data
    for issue in data:
        if not isinstance(issue, dict) or marker not in str(issue.get("body") or ""):
            continue
        if str(issue.get("createdAt") or "") >= started_at:
            return True, issue
    return True, None


def gh_existing_comment_parts(
    repository: str, issue_number: str, key: str, digest: str, total: int
) -> tuple[bool, set[int] | str]:
    found: set[int] = set()
    page_number = 1
    while True:
        ok, page = _gh_json(
            [
                "gh", "api",
                f"repos/{repository}/issues/{issue_number}/comments"
                f"?per_page=100&page={page_number}",
            ]
        )
        if not ok:
            return False, page
        for comment in page:
            body = str(comment.get("body") or "") if isinstance(comment, dict) else ""
            for match in ISSUE_MARKER_PATTERN.finditer(body):
                if (
                    match.group("key") == key
                    and match.group("digest") == digest
                    and int(match.group("total")) == total
                ):
                    found.add(int(match.group("part")))
        if len(page) < 100:
            break
        page_number += 1
    return True, found


def reserve_inflight(
    key: str, reservation: dict, gateway_dir: Path
) -> tuple[bool, dict | None]:
    """Durably reserve an oversized publication before any remote mutation."""
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return False, None
        inflight = state.get("inflight")
        if not isinstance(inflight, dict):
            inflight = {}
        existing = inflight.get(key)
        if isinstance(existing, dict):
            return True, existing
        inflight[key] = reservation
        state["inflight"] = inflight
        try:
            _write_state(path, state)
        except OSError:
            return False, None
    return True, reservation


def read_inflight(key: str, gateway_dir: Path) -> dict | None:
    with _locked_state(gateway_dir) as (_, state):
        inflight = state.get("inflight")
        if not isinstance(inflight, dict):
            return None
        entry = inflight.get(key)
        return entry if isinstance(entry, dict) else None


def record_inflight_issue(
    key: str, record: dict, gateway_dir: Path, completed: set[int]
) -> bool:
    """Record the created issue in published and inflight in one state write."""
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return False
        inflight = state.get("inflight")
        if not isinstance(inflight, dict) or not isinstance(inflight.get(key), dict):
            return False
        entry = inflight[key]
        entry["issue_url"] = record["url"]
        entry["issue_number"] = record["number"]
        entry["completed_parts"] = sorted(completed)
        published = state.get("published")
        if not isinstance(published, dict):
            published = {}
        published[key] = record
        state["published"] = published
        try:
            _write_state(path, state)
        except OSError:
            return False
    return True


def record_inflight_progress(
    key: str, completed: set[int], gateway_dir: Path
) -> bool:
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return False
        inflight = state.get("inflight")
        if not isinstance(inflight, dict) or not isinstance(inflight.get(key), dict):
            return False
        inflight[key]["completed_parts"] = sorted(completed)
        try:
            _write_state(path, state)
        except OSError:
            return False
    return True


def finish_inflight(key: str, gateway_dir: Path) -> bool:
    with _locked_state(gateway_dir) as (path, state):
        if path is None:
            return False
        inflight = state.get("inflight")
        if not isinstance(inflight, dict) or key not in inflight:
            return False
        del inflight[key]
        state["inflight"] = inflight
        try:
            _write_state(path, state)
        except OSError:
            return False
    return True


def publish_oversized_issue(
    *,
    key: str,
    title: str,
    body: str,
    labels: list[str],
    parent: str | None,
    gateway_dir: Path,
    report: list[str],
    mutation_prelude=None,
) -> tuple[bool, dict | None, str]:
    """Create or resume one marker-backed multi-part issue publication."""
    parts = render_oversized_parts(body, key)
    digest = content_digest(body)
    ok, repository_or_error = gh_repository()
    if not ok:
        return False, None, f"could not determine repository: {repository_or_error}"
    repository = repository_or_error
    fingerprint = publication_fingerprint(repository, title, labels, parent, body)
    started_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    reservation = {
        "repository": repository,
        "started_at": started_at,
        "fingerprint": fingerprint,
        "content_sha256": digest,
        "title": title,
        "labels": labels,
        "parent": parent,
        "part_count": len(parts),
        "issue_url": None,
        "issue_number": None,
        "completed_parts": [],
    }
    reserved, entry = reserve_inflight(key, reservation, gateway_dir)
    if not reserved or entry is None:
        return False, None, "could not reserve shared state; no GitHub changes were made"
    if (
        entry.get("fingerprint") != fingerprint
        or entry.get("repository") != repository
        or entry.get("part_count") != len(parts)
    ):
        partial_url = entry.get("issue_url") or "(issue URL not recorded yet)"
        return (
            False,
            None,
            "draft changed while publication is incomplete; refusing to mix versions. "
            f"Existing partial issue: {partial_url}",
        )
    if mutation_prelude is not None:
        report.extend(mutation_prelude())

    issue_url = str(entry.get("issue_url") or "")
    issue_number = str(entry.get("issue_number") or "")
    completed = {
        int(value)
        for value in entry.get("completed_parts", [])
        if isinstance(value, int) or (isinstance(value, str) and value.isdigit())
    }
    recovered = False
    if not issue_url:
        found, issue_or_error = gh_find_reserved_issue(
            repository, str(entry["started_at"]), part_marker(key, digest, 1, len(parts))
        )
        if not found:
            return False, None, f"could not inspect reserved issues: {issue_or_error}"
        if isinstance(issue_or_error, dict):
            issue_url = str(issue_or_error.get("url") or "")
            issue_number = str(issue_or_error.get("number") or "")
            recovered = True

    keep_parent_in_body = bool(parent) and not parent_flag_supported()
    if not issue_url:
        created_ok, info = gh_create_issue(title, parts[0], labels, parent)
        if not created_ok:
            return False, None, f"issue creation failed: {info}"
        issue_url = info
        number_match = re.search(r"/issues/(\d+)", info)
        issue_number = number_match.group(1) if number_match else "?"
    completed.add(1)
    record = {
        "number": issue_number,
        "url": issue_url,
        "title": title,
        "labels": labels,
        "parent": parent,
    }
    if not record_inflight_issue(key, record, gateway_dir, completed):
        return (
            False,
            record,
            f"issue exists at {issue_url}, but its URL could not be recorded; rerun to recover",
        )
    if recovered:
        report.append(f"  Recovered partial issue: {issue_url}")

    if keep_parent_in_body and parent:
        linked, error = gh_link_parent(issue_number, parent)
        if not linked:
            record["parent"] = None
            record_inflight_issue(key, record, gateway_dir, completed)
            report.append(
                f"  WARN  #{issue_number} created, but linking it under #{parent} failed: {error}"
            )

    inspected, existing_or_error = gh_existing_comment_parts(
        repository, issue_number, key, digest, len(parts)
    )
    if not inspected:
        return False, record, f"could not inspect comments on {issue_url}: {existing_or_error}"
    completed.update(existing_or_error)
    if not record_inflight_progress(key, completed, gateway_dir):
        return False, record, f"could not record continuation progress for {issue_url}"

    for index in range(2, len(parts) + 1):
        if index in completed:
            continue
        comment_ok, error = gh_comment_issue(issue_url, parts[index - 1])
        if not comment_ok:
            return (
                False,
                record,
                f"partial issue {issue_url}: continuation part {index} failed: {error}",
            )
        completed.add(index)
        if not record_inflight_progress(key, completed, gateway_dir):
            return (
                False,
                record,
                f"partial issue {issue_url}: part {index} posted but progress could not be recorded",
            )

    if not finish_inflight(key, gateway_dir):
        return False, record, f"all parts exist at {issue_url}, but completion state could not be saved"
    return True, record, ""


def publish_batch(
    batch_dir: Path,
    dry: bool,
    report: list[str],
    created: list[dict] | None = None,
    seed: dict[str, str] | None = None,
    mutation_prelude=None,
) -> tuple[int, int]:
    """Publish (or dry-run) every draft file in one batch directory.

    `created` collects one record per published issue, for durable reference
    resolution and for the notice delivered to the agent on the next prompt.
    `seed` is the resolved map built from the shared state on disk; when omitted, it is
    loaded here, so references to issues published in an earlier run still
    resolve.

    Returns (published_count, failed_count) for this batch.
    """
    files = gather_draft_files(batch_dir)
    if not files:
        return 0, 0

    gateway_dir = batch_dir.parent
    # The seed map is used in place, not copied: entries published here are
    # added to it as the run proceeds, so a caller looping over several
    # batches (publish_issues) lets a later batch reference an earlier
    # batch's freshly created issues without re-reading state.
    resolved = seed if seed is not None else seed_from_state(gateway_dir)
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
                parent_number, retryable = resolve_parent(parent_ref, resolved)
                if parent_number is None and retryable:
                    # The parent may simply be published later in this run.
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

            if dry:
                suffix = f" -> sub-issue of #{parent_number}" if parent_number else ""
                if len(body) > GITHUB_BODY_LIMIT:
                    part_count = len(render_oversized_parts(body, key))
                    suffix += (
                        f" -> {part_count} parts "
                        f"({part_count - 1} continuation comment(s))"
                    )
                report.append(
                    f"  Would create: \"{title}\" [{', '.join(labels)}]{suffix}"
                )
                # Fabricate a placeholder so later dry-run references in
                # this batch resolve too, for a fuller preview.
                resolved[key] = f"NEW-{i}"
                published += 1
                made_progress = True
                continue

            # On a gh without `--parent`, the reference stays in the posted
            # body as a fallback, since the follow-up link can still fail.
            keep_parent_in_body = bool(parent_number) and not parent_flag_supported()
            if keep_parent_in_body:
                body, _ = resolve_references(body_keeping_parent, resolved)

            if len(body) <= GITHUB_BODY_LIMIT:
                existing_inflight = read_inflight(key, gateway_dir)
                if existing_inflight is not None:
                    partial_url = existing_inflight.get("issue_url") or (
                        "issue URL not recorded yet"
                    )
                    failed_entries.append(
                        f"  FAIL  {path.name}: draft changed while publication is "
                        "incomplete; refusing to create a replacement. Existing partial "
                        f"issue: {partial_url}"
                    )
                    made_progress = True
                    continue

            if len(body) > GITHUB_BODY_LIMIT:
                oversized_ok, record, error = publish_oversized_issue(
                    key=key,
                    title=title,
                    body=body,
                    labels=labels,
                    parent=parent_number,
                    gateway_dir=gateway_dir,
                    report=report,
                    mutation_prelude=mutation_prelude,
                )
                if record is not None:
                    resolved[key] = str(record["number"])
                if oversized_ok and record is not None:
                    report.append(
                        f"  Created: {record['url']} "
                        f"({len(render_oversized_parts(body, key))} parts)"
                    )
                    if record.get("parent"):
                        report.append(f"        sub-issue of #{record['parent']}")
                    if created is not None:
                        created.append(record)
                    delete_published_draft(path)
                    published += 1
                else:
                    failed_entries.append(f"  FAIL  {path.name}: {error}")
                made_progress = True
                continue

            if mutation_prelude is not None:
                report.extend(mutation_prelude())
            ok, info = gh_create_issue(title, body, labels, parent_number)
            if ok:
                number_match = re.search(r"/issues/(\d+)", info)
                resolved_number = number_match.group(1) if number_match else "?"
                resolved[key] = resolved_number
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
                    "parent": linked_parent,
                }
                if not record_published(key, record, gateway_dir):
                    # The issue exists on the tracker; losing the state
                    # entry only means a rerun cannot resolve references
                    # to it. A warning, never a failure.
                    report.append(
                        f"  WARN  #{resolved_number} could not be recorded in "
                        "the shared state (locked by another publish?)"
                    )
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
        if parent_ref and resolve_parent(parent_ref, resolved)[0] is None:
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
    labels_ensured = False

    def ensure_labels_once() -> list[str]:
        nonlocal labels_ensured
        if labels_ensured or dry:
            return []
        labels_ensured = True
        return ensure_labels(False)

    # The shared state is loaded up front: reference keys carry their own
    # session id, so a draft can point at an issue another batch published
    # in an earlier run.
    seed = seed_from_state(GATEWAY_DIR)

    total_published = 0
    total_failed = 0
    created: list[dict] = []
    for batch_dir in batch_dirs:
        p, f = publish_batch(
            batch_dir,
            dry,
            report,
            created,
            seed,
            mutation_prelude=ensure_labels_once,
        )
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
