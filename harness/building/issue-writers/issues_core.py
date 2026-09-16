#!/usr/bin/env python3
"""Shared GitHub issue drafting and publishing implementation.

Fires before Claude ever sees the prompt. When the prompt is "/publish-issues"
(optionally with "--dry"), this script does all the work itself with `gh` and
exits 2, which erases the prompt and shows stderr to the user only - zero API
calls for this step.

Design notes:
- Every draft is one flat file in ".harness/issue-drafts/", named
  "{session-id}.issue-{i}.md". The session id in the filename is the only
  thing that groups a batch: there is no per-session folder, so no session can
  ever create, remove, or race a container another session is writing into.
  Native UserPromptSubmit adapters inject the session id and next free draft
  index before a drafting skill runs.
- Sorting a session's files by `i` gives a stable creation order, so an issue
  can only reference an issue created earlier in the same batch (no forward
  references), assuming /draft-issues emitted a correct topological order.
  This script no longer *assumes* that ordering is perfect - see the retry
  pass below.
- The first "# " header line in a draft file is the issue title. The first
  non-empty line after that declares labels (see /draft-issues, /draft-issue,
  /to-spec-draft-issue): "> " followed by a comma-separated list of label
  tokens in any order. Every draft uses this same format - a spec is just a
  draft whose tokens include "spec". "difficulty:{level}" and "mode:{afk|hitl}"
  are each optional, and extra labels the user asked for may be added
  alongside. Aliased tokens map to the workflow's own "[AI]-" prefixed label
  names via LABEL_ALIASES, then are stripped from the body that gets posted.
  Extra (non-aliased) tokens pass through as-is, and the drafting skills are
  responsible for checking with `gh label list` that they exist.
- A reference to another draft issue, written as plain text "{session-id}/{i}"
  in the body (no backticks, no braces - GitHub only autolinks a bare
  "#<number>", so the resolved replacement must not sit inside inline code),
  is rewritten to "#<real-issue-number>" once that draft has been published.
- Once an issue is published, its draft file is deleted immediately. If a
  later draft cannot publish in the same run, any references that are already
  known are rewritten *into* that remaining draft before it is left in place.
  That is the whole cross-run memory: no ledger, no state file. A rerun
  resolves references by reading the drafts that are still on disk.
- Within a single run, unresolved references are retried in a worklist loop
  rather than skipped once, which self-heals ordering mistakes and only
  reports a failure for references still unresolved after every file that
  *could* make progress has been tried.
- The body is always passed to `gh` via --body-file (a temp file), never
  inline on the command line. This is what avoids the Windows command-line
  length limit, on every platform, regardless of body size.
- Crash safety costs no extra file and no extra `gh` call. A draft is renamed
  with a ".publishing" suffix immediately before `gh issue create` and
  removed once the issue exists; a failed create renames it back. A file left
  in the ".publishing" state is therefore the only evidence of a crash mid
  publish, and the next run resolves it with a single title search rather than
  blindly creating a duplicate.
- A body over GitHub's size limit is posted as one issue plus continuation
  comments. If a continuation fails, the issue still exists, so the draft is
  discarded and the gap is reported loudly - this tool does not resume a
  partial publication.
- A "## Parent" section whose first non-empty line is a bare reference
  ("#42", an issue URL, or "{session-id}/{i}") makes the new issue a real
  GitHub sub-issue of that parent. Parents are structural, not label-based:
  any draft can be a parent. Knowing the number is not enough, so the link is
  made with `gh issue create --parent` (or, on a gh too old for that flag, a
  follow-up `gh issue edit --parent`). The section is stripped from the posted
  body once the link is made. Prose under "## Parent" is left as written.
- Publishing runs with no model turn at all (exit 2 erases the prompt), so the
  agent would otherwise never learn the real issue numbers. Each run writes
  what it created to a notice file *outside* the repository; the next prompt
  in that session that isn't a publish command delivers it as
  `additionalContext` and deletes it. It rides along with a prompt the user
  was sending anyway, so it costs no extra API call - and it lets the next
  drafting turn write a real "#42" under "## Parent".
- Nothing this tool needs to remember is kept inside the working tree. The
  publish lock and the pending notice both live under HARNESS_STATE_DIR (or
  ~/.harness), so a repository only ever holds drafts and a .gitignore.
- Drafts untouched for SESSION_MAX_AGE are deleted, along with notice files
  that were never delivered. Per-file, because there is no folder whose mtime
  could stand in for a batch. That is the only garbage collection, and it runs
  automatically - there is no cleanup command to learn.
- "--dry" runs the exact same parse/resolve/chunk-count logic but never
  invokes `gh`, never deletes files, and never writes a notice - it reports
  what would happen, so a bad label line or a genuinely unresolvable reference
  can be caught before anything touches the tracker.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from contextvars import ContextVar
from pathlib import Path

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

# Beside the other per-project Harness configuration (.harness/guards/ and
# friends), so a project grows one dot-folder rather than one per tool.
DRAFTS_DIR = Path(".harness/issue-drafts")
GH_DEADLINE: ContextVar[float | None] = ContextVar("issues_gh_deadline", default=None)

# Everything this tool remembers between runs lives here, never in the user's
# repository. Mirrors the convention in src/harness_cli/receipts.py.
STATE_DIR_VARIABLE = "HARNESS_STATE_DIR"

# A draft mid-publish. The rename is the entire crash-recovery mechanism.
PUBLISHING_SUFFIX = ".publishing"

# Drafts idle this long are deleted.
SESSION_MAX_AGE = 7 * 24 * 3600

# Keeps a huge batch well under the 10,000-character cap on additionalContext.
MAX_NOTICE_ENTRIES = 50

# GitHub applies the same character limit to issue bodies and comments.
GITHUB_BODY_LIMIT = 65_536
CHUNK_TARGET = 60_000

FENCE_PATTERN = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")

# Provider skill invocations may appear at the start of a prompt or after
# whitespace in a longer user message.
PROMPT_PATTERN = re.compile(r"(?<!\S)[$@/]publish-issues?(?=\s|$)")
DRAFT_PATTERN = re.compile(
    r"(?<!\S)[$@/](draft-issue|draft-issues|to-spec-draft-issue)(?=\s|$)"
)

# An issues session id: a Claude Code session id (a UUID), or the UUID a
# ChatGPT thread id is mapped onto by the adapter.
_SESSION_ID = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
SESSION_ID_PATTERN = re.compile(rf"^{_SESSION_ID}$")

# A reference to another draft issue, written as plain text
# "6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/0" - in a body ("Blocked by") or under
# "## Parent". {i} is the target draft's filename index. Matching the full UUID
# keeps the pattern unambiguous without needing wrappers like "{...}".
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

# The draft filename convention produced by the drafting skills:
# "{session-id}.issue-{i}.md". "." separates the two fields because it is the
# one character a UUID cannot contain - "-" appears inside the id itself.
# Groups are named: positional order would be an easy thing to get wrong.
FILENAME_PATTERN = re.compile(
    rf"^(?P<session>{_SESSION_ID})\.issue-(?P<index>\d+)\.md$"
)
PUBLISHING_PATTERN = re.compile(
    rf"^(?P<session>{_SESSION_ID})\.issue-(?P<index>\d+)\.md"
    + re.escape(PUBLISHING_SUFFIX)
    + r"$"
)


def draft_name(session_id: str, index: int | str) -> str:
    """The filename one draft of a session takes."""
    return f"{session_id}.issue-{index}.md"

# The label declaration line every drafting skill produces - specs included:
# "> " followed by a comma-separated list of label tokens in any order. A token
# is one or more whitespace-separated words, each word carrying an optional
# ":suffix" (the "difficulty:*" / "mode:*" form), so multi-word extra labels
# like "good first issue" parse.
_LABEL_WORD = r"[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?"
_LABEL_TOKEN = rf"{_LABEL_WORD}(?:\s+{_LABEL_WORD})*"
LABEL_LINE_PATTERN = re.compile(
    rf"^\s*>(?:\s*{_LABEL_TOKEN}\s*,)*\s*{_LABEL_TOKEN}\s*$",
    re.IGNORECASE,
)

# Canonical labels this workflow depends on: (color, description). They carry
# an "[AI]-" prefix so they can't collide with a repo's own labels. They are
# created immediately before the run's first remote mutation if missing;
# existing labels are left alone, so the user's own styling is never
# overwritten.
CANONICAL_LABELS = {
    "[AI]-routine-difficulty": (
        "0E8A16",
        "Low reasoning level work (renames, cleanups, missing type hints) - use rarely.",
    ),
    "[AI]-basic-difficulty": (
        "FBCA04",
        "Easy refactoring, missing tests, or documentation updates.",
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
        "Sensitive or complex work requiring human review before landing.",
    ),
    "[AI]-chrome": (
        "4285F4",
        "Requires a real browser to test a design change end to end.",
    ),
    "[AI]-spec": ("7057FF", "A spec synthesized from conversation."),
}

# The declaration line uses the tokens below; the labels actually created and
# applied are the names above. Any other token is applied as-is.
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


# The out-of-repo store


def store_dir() -> Path:
    """Where the publish lock and pending notices live, never in the repo."""
    configured = os.environ.get(STATE_DIR_VARIABLE)
    root = Path(configured).expanduser() if configured else Path.home() / ".harness"
    return root / "issues"


def _repo_id(root: Path) -> str:
    """A stable, filename-safe identity for one working tree.

    A digest rather than a sanitized path: the full path is too long for a
    filename on Windows, and two different repositories must never collide.
    """
    try:
        resolved = Path(root).resolve()
    except OSError:
        resolved = Path(root).absolute()
    return hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:16]


def lock_path(root: Path) -> Path:
    """One publish lock per repository. Sessions publish disjoint batches, but
    label creation and the stale sweep are shared, so publishing serializes."""
    return store_dir() / f"{_repo_id(root)}.lock"


def notice_path(root: Path, session_id: str) -> Path:
    """One pending notice per session, so a session only ever reads its own."""
    return store_dir() / f"{_repo_id(root)}-{session_id}.notice.json"


@contextlib.contextmanager
def file_lock(path: Path):
    """Try an OS file lock that is released even if the process is killed."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        lock = path.open("a+b", buffering=0)
    except OSError:
        yield False
        return
    with lock:
        try:
            if lock.tell() == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            if sys.platform == "win32":
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0)
            with contextlib.suppress(OSError):
                if sys.platform == "win32":
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def run_gh(args, **kwargs):
    """Optionally bound all GitHub calls by one invocation's monotonic deadline."""
    deadline = GH_DEADLINE.get()
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(args, 0)
        kwargs["timeout"] = min(30, remaining)
    return subprocess.run(args, **kwargs)


# Drafting context


def prepare_drafting_context(root: Path, session_id: str) -> str:
    """Prepare the drafts directory and return the values skills must use."""
    drafts = root / DRAFTS_DIR
    drafts.mkdir(parents=True, exist_ok=True)
    # Beside the drafts, never at .harness/ level: the sibling directories hold
    # guard policies and launcher configuration the user commits on purpose.
    ignore = drafts / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8", newline="\n")
    sweep_stale(root)

    indexes = []
    for path in drafts.iterdir():
        match = FILENAME_PATTERN.match(path.name) or PUBLISHING_PATTERN.match(
            path.name
        )
        if match and match["session"] == session_id:
            indexes.append(int(match["index"]))
    next_index = max(indexes, default=-1) + 1
    template = (DRAFTS_DIR / draft_name(session_id, next_index)).as_posix()
    return (
        f"Draft file path: {template}\n"
        "Increments the index by 1 gives you the next issue file path, counting up "
        "from this draft index. Use these exact values to create drafts."
    )


# The pending notice, delivered on the next prompt


def queue_notice(
    root: Path, session_id: str, created: list[dict], failed: int
) -> None:
    """Stage what this run published for delivery on the next prompt.

    Appends rather than overwrites: two publish runs in a row (the second
    prompt is another /publish-issues, so nothing was flushed in between)
    must both reach the agent.
    """
    if not created and not failed:
        return
    path = notice_path(root, session_id)
    pending = _read_notice(path)
    entries = pending.get("created", [])
    available = max(0, MAX_NOTICE_ENTRIES - len(entries))
    entries.extend(
        {
            "number": entry.get("number"),
            "title": entry.get("title"),
            "labels": entry.get("labels") or [],
        }
        for entry in created[:available]
    )
    payload = {
        "created": entries,
        "failed": pending.get("failed", 0) + failed,
        "omitted": pending.get("omitted", 0) + max(0, len(created) - available),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    except OSError:
        pass


def _read_notice(path: Path) -> dict:
    """Best-effort read. A damaged notice must never block a prompt."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    created = data.get("created")
    return {
        "created": [entry for entry in created if isinstance(entry, dict)]
        if isinstance(created, list)
        else [],
        "failed": data.get("failed") if isinstance(data.get("failed"), int) else 0,
        "omitted": data.get("omitted") if isinstance(data.get("omitted"), int) else 0,
    }


def flush_notice(root: Path, session_id: str) -> str | None:
    """Consume this session's pending notice, if any. Delivered exactly once."""
    path = notice_path(root, session_id)
    if not path.is_file():
        return None
    pending = _read_notice(path)
    with contextlib.suppress(OSError):
        path.unlink()
    created = pending.get("created", [])
    failed = pending.get("failed", 0)
    omitted = pending.get("omitted", 0)
    if not created and not failed and not omitted:
        return None
    return format_notice(created, failed, omitted)


def format_notice(created: list[dict], failed: int, omitted: int = 0) -> str:
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
        remaining = max(0, len(created) - MAX_NOTICE_ENTRIES) + omitted
        if remaining > 0:
            lines.append(f"- ... and {remaining} more")
    if failed:
        lines.append("")
        lines.append(
            f"{failed} draft(s) failed or were skipped and are still in "
            f"{DRAFTS_DIR.as_posix()}/ awaiting a rerun."
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


# Automatic cleanup


def sweep_stale(root: Path, now: float | None = None) -> None:
    """Delete drafts and notices nothing has touched in a week.

    Age-based and per-file, so it can never race with a drafting turn that is
    midway through writing its files, and a draft's own mtime decides its fate
    rather than a directory's.
    """
    now = time.time() if now is None else now
    cutoff = now - SESSION_MAX_AGE
    drafts = root / DRAFTS_DIR
    if drafts.is_dir():
        for path in drafts.iterdir():
            if not (
                FILENAME_PATTERN.match(path.name)
                or PUBLISHING_PATTERN.match(path.name)
            ):
                continue  # never touch a file this tool did not write
            try:
                if path.stat().st_mtime <= cutoff:
                    path.unlink()
            except OSError:
                continue
    store = store_dir()
    if store.is_dir():
        prefix = f"{_repo_id(root)}-"
        for notice in store.glob(f"{prefix}*.notice.json"):
            try:
                if notice.stat().st_mtime <= cutoff:
                    notice.unlink()
            except OSError:
                continue


# Draft parsing - the format the SKILL.md files document


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

    Returns (labels, remaining_body). labels is empty if the line is missing or
    malformed (e.g. a ">" quote, or a list carrying a token that can't be a
    label) - the whole line is left in the body untouched rather than silently
    applying a partial set of labels.
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

    The section is removed only when its first non-empty line is a reference
    (or an explicit "none"), since that is the case where the information moves
    into GitHub's own sub-issue link. A section holding prose - including the
    template's own placeholder text - is left untouched and yields no parent.
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
    reference resolves once the issue it points at has been published, and is
    retryable until then - the parent may simply be later in this same run.
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


def _gather(drafts_dir: Path, session_id: str, pattern: re.Pattern) -> list[Path]:
    """One session's files matching `pattern`, in stable index order."""
    ordered = []
    if not drafts_dir.is_dir():
        return []
    for path in drafts_dir.iterdir():
        match = pattern.match(path.name)
        # Stray files, and every other session's drafts, are not ours to read.
        if not match or match["session"] != session_id:
            continue
        ordered.append((int(match["index"]), path))
    ordered.sort(key=lambda item: item[0])
    return [path for _, path in ordered]


def gather_draft_files(drafts_dir: Path, session_id: str) -> list[Path]:
    """List a session's drafts, in stable, dependency-safe order."""
    return _gather(drafts_dir, session_id, FILENAME_PATTERN)


def gather_interrupted_files(drafts_dir: Path, session_id: str) -> list[Path]:
    """List drafts a crash left mid-publish, in the same stable order."""
    return _gather(drafts_dir, session_id, PUBLISHING_PATTERN)


def rewrite_known_references(path: Path, resolved: dict[str, str]) -> None:
    """Persist any known reference rewrites in a draft that remains pending.

    This is what lets a rerun resolve a reference to an issue published in an
    earlier run: the number is written into the draft that still needs it, so
    no separate ledger has to survive between runs.
    """
    if not resolved:
        return

    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return

    def _sub(match: re.Match) -> str:
        key = f"{match.group(1)}/{match.group(2)}"
        if key in resolved:
            return f"#{resolved[key]}"
        return match.group(0)

    rewritten = REF_PATTERN.sub(_sub, text)
    if rewritten != text:
        with contextlib.suppress(OSError):
            path.write_text(rewritten, encoding="utf-8")


# Splitting a body that exceeds GitHub's limit


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


def render_parts(body: str) -> list[str]:
    """Render a body as one issue body plus any continuation comments."""
    if len(body) <= GITHUB_BODY_LIMIT:
        return [body]
    # 512 comfortably covers the generated headings even for large counts.
    content_limit = CHUNK_TARGET - 512
    while True:
        chunks = chunk_markdown(body, content_limit)
        total = len(chunks)
        rendered = []
        for index, chunk in enumerate(chunks, 1):
            if index == 1:
                heading = (
                    f"> **Part 1 of {total}.** The remaining parts follow in "
                    "continuation comments."
                )
            else:
                heading = f"## Continuation - Part {index} of {total}"
            rendered.append(f"{heading}\n\n{chunk}")
        largest = max(map(len, rendered))
        if largest <= CHUNK_TARGET:
            if any(len(payload) > GITHUB_BODY_LIMIT for payload in rendered):
                raise ValueError("rendered issue part exceeds GitHub's body limit")
            return rendered
        content_limit -= largest - CHUNK_TARGET + 16
        if content_limit <= 0:
            raise ValueError("generated continuation metadata exceeds payload target")


# The gh boundary


def ensure_labels(dry: bool) -> list[str]:
    """Create the canonical labels that are missing; never touch existing ones.

    "gh label create" exits non-zero with an "already exists" error when the
    label is present, so a plain create is create-only: an existing label's
    color and description are left exactly as the user has them.
    """
    if dry:
        return []

    warnings = []
    for name, (color, description) in CANONICAL_LABELS.items():
        result = run_gh(
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
            result = run_gh(
                ["gh", "issue", "create", "--help"], capture_output=True, text=True
            )
            _parent_flag_supported = "--parent" in (
                (result.stdout or "") + (result.stderr or "")
            )
        except OSError:
            _parent_flag_supported = False
    return _parent_flag_supported


def _run_with_body_file(args: list[str], body: str) -> subprocess.CompletedProcess:
    """Run gh with a UTF-8 temporary body file whose newlines stay LF on Windows."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8", newline="\n"
    ) as tmp:
        tmp.write(body)
        tmp_path = tmp.name
    try:
        return run_gh(
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
    if not re.fullmatch(r"https://[^/]+/[^/]+/[^/]+/issues/\d+", url):
        return False, "gh returned no valid issue URL"
    return True, url


def gh_comment_issue(issue_url: str, body: str) -> tuple[bool, str]:
    result = _run_with_body_file(["gh", "issue", "comment", issue_url], body)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    return True, (result.stdout or "").strip()


def gh_link_parent(child: str, parent: str) -> tuple[bool, str]:
    """Attach an existing issue to a parent (the older-gh fallback path)."""
    result = run_gh(
        ["gh", "issue", "edit", child, "--parent", parent],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    return True, ""


def gh_find_issues_by_title(title: str) -> tuple[bool, list[dict] | str]:
    """Find issues whose title matches exactly. The crash-recovery query.

    Runs only for a draft a crash left in the ".publishing" state, so it costs
    nothing on the happy path.
    """
    result = run_gh(
        [
            "gh", "issue", "list", "--search", f"{title} in:title",
            "--state", "all", "--limit", "50",
            "--json", "number,title,url",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()
    try:
        data = json.loads(result.stdout or "[]")
    except ValueError:
        return False, "gh returned malformed JSON"
    if not isinstance(data, list):
        return False, "gh returned an unexpected JSON shape"
    return True, [
        issue
        for issue in data
        if isinstance(issue, dict) and issue.get("title") == title
    ]


# Publishing


def recover_interrupted(
    drafts_dir: Path, session_id: str, resolved: dict[str, str], report: list[str]
) -> int:
    """Resolve drafts a crash left mid-publish. Returns the failure count.

    A ".publishing" file means `gh issue create` may or may not have run. One
    title search settles it: if the issue exists the draft has done its job and
    is discarded, otherwise it goes back to being an ordinary draft.
    """
    failures = 0
    for path in gather_interrupted_files(drafts_dir, session_id):
        match = PUBLISHING_PATTERN.match(path.name)
        original = path.with_name(draft_name(session_id, match["index"]))
        title, _ = parse_issue_file(path)
        ok, matches = gh_find_issues_by_title(title)
        if not ok:
            report.append(
                f"  FAIL  {original.name} was interrupted mid-publish and GitHub "
                f"could not be queried: {matches}"
            )
            failures += 1
            continue
        if len(matches) > 1:
            report.append(
                f"  FAIL  {original.name} was interrupted mid-publish and several "
                f"issues share the title \"{title}\". Reconcile them, then remove "
                f"{path.name}."
            )
            failures += 1
            continue
        if matches:
            number = str(matches[0].get("number"))
            resolved[f"{session_id}/{match['index']}"] = number
            report.append(
                f"  Recovered: {original.name} was already published as "
                f"#{number}; discarding the draft."
            )
            with contextlib.suppress(OSError):
                path.unlink()
            continue
        with contextlib.suppress(OSError):
            path.rename(original)
        report.append(
            f"  Recovered: {original.name} was interrupted before it reached "
            "GitHub; publishing it now."
        )
    return failures


def publish_one(
    title: str, body: str, labels: list[str], parent: str | None, path: Path
) -> tuple[bool, dict | None, str]:
    """Create one issue, renaming the draft across the unsafe window.

    The rename is the crash record: between it and the unlink, a dead process
    leaves a ".publishing" file that the next run resolves with a title search
    instead of blindly creating a duplicate.
    """
    parts = render_parts(body)
    publishing = path.with_name(path.name + PUBLISHING_SUFFIX)
    try:
        path.rename(publishing)
    except OSError as exc:
        return False, None, f"could not claim the draft for publishing: {exc}"

    created, info = gh_create_issue(title, parts[0], labels, parent)
    if not created:
        with contextlib.suppress(OSError):
            publishing.rename(path)
        return False, None, f"issue creation failed: {info}"

    url = info
    number_match = re.search(r"/issues/(\d+)", url)
    number = number_match.group(1) if number_match else "?"
    record = {
        "number": number,
        "url": url,
        "title": title,
        "labels": labels,
        "parent": parent,
        "parts": len(parts),
    }
    # The issue exists, so the draft has done its job either way.
    with contextlib.suppress(OSError):
        publishing.unlink()

    for index, payload in enumerate(parts[1:], 2):
        posted, error = gh_comment_issue(url, payload)
        if not posted:
            record["truncated"] = index
            return False, record, (
                f"{url} exists but continuation part {index} of {len(parts)} "
                f"failed: {error}. The remaining parts were not posted and the "
                "draft is gone - repost them by hand or redraft the issue."
            )
    return True, record, ""


def publish_batch(
    drafts_dir: Path,
    session_id: str,
    dry: bool,
    report: list[str],
    created: list[dict] | None = None,
    mutation_prelude=None,
) -> tuple[int, int]:
    """Publish (or dry-run) every draft belonging to one session.

    `created` collects one record per published issue, for the notice
    delivered to the agent on the next prompt.

    Returns (published_count, failed_count) for this batch.
    """
    # Entries published here are added as the run proceeds, so later drafts in
    # this batch can resolve references to earlier ones.
    resolved: dict[str, str] = {}
    recovery_failures = (
        0 if dry else recover_interrupted(drafts_dir, session_id, resolved, report)
    )

    files = gather_draft_files(drafts_dir, session_id)
    if not files:
        return 0, recovery_failures

    report.append(f"Batch: {len(files)} draft issue(s)")
    report.append("")

    # Worklist retry: a file with an unresolved reference goes back on the
    # queue instead of being skipped permanently, so ordering mistakes (e.g. a
    # diamond dependency numbered out of order) self-heal within this run.
    # Bounded to len(files) passes - a true cycle or a reference to something
    # outside the batch will still be unresolved after that many attempts and
    # gets reported as a real failure.
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

            match = FILENAME_PATTERN.match(path.name)
            if not match:
                continue
            index = match["index"]
            key = f"{session_id}/{index}"

            if dry:
                suffix = f" -> sub-issue of #{parent_number}" if parent_number else ""
                part_count = len(render_parts(body))
                if part_count > 1:
                    suffix += (
                        f" -> {part_count} parts "
                        f"({part_count - 1} continuation comment(s))"
                    )
                report.append(
                    f"  Would create: \"{title}\" [{', '.join(labels)}]{suffix}"
                )
                # Fabricate a placeholder so later dry-run references in this
                # batch resolve too, for a fuller preview.
                resolved[key] = f"NEW-{index}"
                published += 1
                made_progress = True
                continue

            # On a gh without `--parent`, the reference stays in the posted body
            # as a fallback, since the follow-up link can still fail.
            keep_parent_in_body = bool(parent_number) and not parent_flag_supported()
            if keep_parent_in_body:
                body, _ = resolve_references(body_keeping_parent, resolved)

            if mutation_prelude is not None:
                report.extend(mutation_prelude())

            ok, record, error = publish_one(title, body, labels, parent_number, path)
            if record is not None:
                resolved[key] = str(record["number"])
            if ok and record is not None:
                suffix = f" ({record['parts']} parts)" if record["parts"] > 1 else ""
                report.append(f"  Created: {record['url']}{suffix}")
                if parent_number and keep_parent_in_body:
                    linked, link_error = gh_link_parent(record["number"], parent_number)
                    if not linked:
                        record["parent"] = None
                        report.append(
                            f"  WARN  #{record['number']} created, but linking it "
                            f"under #{parent_number} failed: {link_error}"
                        )
                if record.get("parent"):
                    report.append(f"        sub-issue of #{record['parent']}")
                if created is not None:
                    created.append(record)
                published += 1
            else:
                failed_entries.append(f"  FAIL  {path.name}: {error}")
                if record is not None and created is not None:
                    # The issue exists, so the agent must still learn its number.
                    created.append(record)
            made_progress = True

        pending = still_pending
        if not made_progress:
            break

    # Anything still pending after the retry loop is a genuine problem: either
    # a reference outside this batch, or a real dependency cycle.
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
    return published, len(failed_entries) + recovery_failures


def publish_issues(dry: bool, session_id: str, root: Path | None = None) -> str:
    """Publish drafts belonging to the current agent session only."""
    root = Path.cwd() if root is None else root
    drafts_dir = root / DRAFTS_DIR
    if not drafts_dir.is_dir():
        return (
            f"No {DRAFTS_DIR.as_posix()}/ folder found. Run /draft-issue, "
            "/draft-issues first."
        )

    if not SESSION_ID_PATTERN.fullmatch(session_id):
        return "Invalid or missing issues session id. Nothing was published."

    def nothing_to_publish() -> bool:
        return not gather_draft_files(
            drafts_dir, session_id
        ) and not gather_interrupted_files(drafts_dir, session_id)

    if nothing_to_publish():
        return "No drafts found for this session. Nothing to publish."

    if dry:
        return _run_publish(drafts_dir, True, root, session_id)

    with file_lock(lock_path(root)) as acquired:
        if not acquired:
            return (
                "Another publish is already running for this repository. "
                "Retry once it finishes."
            )
        sweep_stale(root)
        if nothing_to_publish():
            return "No drafts found for this session. Nothing to publish."
        return _run_publish(drafts_dir, False, root, session_id)


def _run_publish(drafts_dir: Path, dry: bool, root: Path, session_id: str) -> str:
    header = "Dry run -- nothing will be created" if dry else "Publishing drafted issues"
    report = [header, ""]
    labels_ensured = False

    def ensure_labels_once() -> list[str]:
        nonlocal labels_ensured
        if labels_ensured or dry:
            return []
        labels_ensured = True
        return ensure_labels(False)

    created: list[dict] = []
    published, failed = publish_batch(
        drafts_dir, session_id, dry, report, created, mutation_prelude=ensure_labels_once
    )
    report.append("")

    if not dry:
        queue_notice(root, session_id, created, failed)

    if dry:
        report.append(f"Dry run complete: {published} issue(s) ready to publish.")
        if failed:
            report.append(f"{failed} would be skipped (see above).")
    elif failed:
        report.append(
            f"Published {published} issue(s). {failed} failed or were skipped."
        )
        report.append(
            f"Failed drafts remain in {DRAFTS_DIR.as_posix()}/ -- fix and rerun."
        )
    else:
        report.append(f"Published {published} issue(s) successfully.")

    return "\n".join(report)


def run_publish_command(prompt: str, session_id: str, root: Path | None = None) -> str:
    """Parse and execute the hook's user-facing publish interface.

    The whole surface is "/publish-issues" and "/publish-issues --dry".
    Cleanup is automatic, so there is no cleanup command to learn.
    """
    invocation = PROMPT_PATTERN.search(prompt)
    if invocation is None:
        return "Invalid publish command: invocation not found"
    try:
        tokens = shlex.split(prompt[invocation.start():])
    except ValueError as exc:
        return f"Invalid publish command: {exc}"
    parser = argparse.ArgumentParser(add_help=False, exit_on_error=False)
    parser.add_argument("--dry", action="store_true")
    try:
        options, extras = parser.parse_known_args(tokens[1:])
        if extras:
            raise ValueError(
                f"unknown option: {' '.join(extras)}. Use /publish-issues or "
                "/publish-issues --dry."
            )
    except (argparse.ArgumentError, ValueError) as exc:
        return f"Invalid publish command: {exc}"
    return publish_issues(options.dry, session_id, root)
