#!/usr/bin/env python3
"""
Claude Code UserPromptSubmit hook for `/commit <message>`.

Runs BEFORE the prompt is sent to the model. If the prompt matches
`/commit <message>`, this script stages + commits changes itself and
rejects the prompt with a status string, which Claude Code shows
directly to the user. The model is never called for this turn.

Any other prompt is let through untouched.
"""
import json
import os
import re
import subprocess
import sys
from collections import namedtuple

COMMIT_PATTERN = re.compile(r"^/commit(?:\s+(.*))?$", re.DOTALL)

# Leading flags accepted before the commit message.
DRY_RUN_FLAGS = {"--dry-run", "-n"}

# Tools whose invocation means "this file was modified on disk".
# Read/Grep/Glob are excluded: they touch nothing.
WRITE_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit", "Update"}

# Result of reading a transcript. Everything the dry run needs to explain
# itself, including the paths that were deliberately discarded — those are
# the silent filters, and silent filters are what make a hook baffling.
WriteScan = namedtuple(
    "WriteScan",
    "paths outside failed_paths records write_calls",
)


def split_flags(rest: str):
    """
    Peel recognised flags off the front of `/commit ...`, returning
    (dry_run, message). Flags must precede the message, otherwise a
    message legitimately containing the word --dry-run would be
    misread as a flag.
    """
    dry_run = False
    while rest:
        stripped = rest.lstrip()
        if not stripped:
            break
        parts = stripped.split(None, 1)
        if parts[0] not in DRY_RUN_FLAGS:
            break
        dry_run = True
        rest = parts[1] if len(parts) > 1 else ""
    return dry_run, rest.strip()


def _iter_transcript(transcript_path: str):
    """
    Yield parsed records from a JSONL transcript, skipping anything
    unparseable. Transcripts are appended to live, so the final line can
    be a partial write; a bad line must never sink the whole commit.
    """
    with open(transcript_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except (ValueError, TypeError):
                continue
            if isinstance(record, dict):
                yield record


def _content_blocks(record: dict):
    """Tool blocks live under message.content, which is a list or a bare string."""
    message = record.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    return content if isinstance(content, list) else []


def _scan_writes(transcript_path: str, repo_root: str):
    """
    Parse the session transcript for file-writing tool_use entries and
    return a WriteScan describing what was found and what was discarded.
    Returns None if the transcript can't be read at all.

    Notes on the transcript format, which the parsing below relies on:

    - Write tool calls are `tool_use` blocks inside `assistant` records.
    - `file_path` is usually absolute but not always, so relative paths
      are resolved against the *record's own* cwd, not the hook's.
    - A tool call that failed is reported later, in a `tool_result` block
      carrying `is_error`, so ids are collected first and filtered at the
      end rather than trusting the call site.
    - Records are NOT filtered by session_id: resuming a session carries
      earlier records (with their original session_id) into the new
      transcript, and that earlier work is just as uncommitted as the
      rest. The transcript file is the correct scope.
    - Subagent (`isSidechain`) writes are included; they edit real files.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return None

    calls = []  # (tool_use_id, abs path) in transcript order
    failed_ids = set()
    records = 0

    try:
        for record in _iter_transcript(transcript_path):
            records += 1
            record_cwd = record.get("cwd") or repo_root

            for block in _content_blocks(record):
                if not isinstance(block, dict):
                    continue

                block_type = block.get("type")

                if block_type == "tool_result":
                    if block.get("is_error"):
                        tool_use_id = block.get("tool_use_id")
                        if tool_use_id:
                            failed_ids.add(tool_use_id)
                    continue

                if block_type != "tool_use":
                    continue
                if block.get("name") not in WRITE_TOOLS:
                    continue

                tool_input = block.get("input")
                if not isinstance(tool_input, dict):
                    continue

                raw_path = tool_input.get("file_path") or tool_input.get("notebook_path")
                if not isinstance(raw_path, str) or not raw_path.strip():
                    continue

                if not os.path.isabs(raw_path):
                    raw_path = os.path.join(record_cwd, raw_path)

                tool_use_id = block.get("id") or f"_anon{len(calls)}"
                calls.append((tool_use_id, os.path.normpath(raw_path)))
    except OSError:
        return None

    # Keep only writes that actually succeeded, deduped, order preserved.
    succeeded = []
    seen = set()
    for tool_use_id, path in calls:
        if tool_use_id in failed_ids or path in seen:
            continue
        seen.add(path)
        succeeded.append(path)

    # A path is only reported as failed if *no* call against it worked;
    # one bad Edit followed by a good one is not a dropped file.
    failed_paths = []
    for tool_use_id, path in calls:
        if tool_use_id in failed_ids and path not in seen and path not in failed_paths:
            failed_paths.append(path)

    # Drop anything outside the repo. Claude may well have edited
    # ~/.claude/settings.json mid-session, and a single out-of-tree
    # pathspec makes `git add` fail and takes the whole commit with it.
    inside, outside = [], []
    for path in succeeded:
        (inside if _is_within(path, repo_root) else outside).append(path)

    return WriteScan(
        paths=inside,
        outside=outside,
        failed_paths=failed_paths,
        records=records,
        write_calls=len(calls),
    )


def get_changed_paths(transcript_path: str, repo_root: str):
    """
    Absolute paths Claude wrote to this session, so we only stage what it
    actually changed rather than every dirty file in the repo. None means
    "no usable list", telling the caller to fall back to staging all.
    """
    scan = _scan_writes(transcript_path, repo_root)
    if scan is None:
        return None
    return scan.paths or None


def _is_within(path: str, root: str) -> bool:
    try:
        return not os.path.relpath(path, root).startswith(os.pardir)
    except ValueError:
        # Different drives on Windows.
        return False


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def finish(message: str, ok: bool):
    """
    Reject the prompt either way (success or failure) so it never reaches
    the model. `message` is what the user sees in place of a response.
    Exit code 2 is what makes Claude Code treat stderr as the rejection
    reason for a UserPromptSubmit hook.
    """
    sys.stderr.write(message if message.endswith("\n") else message + "\n")
    sys.exit(2 if True else 0)  # always 2: we always want to block this turn


def allow():
    """Let the prompt through unchanged; a normal model turn follows."""
    sys.exit(0)


def resolve_stage_set(paths, cwd):
    """
    Split the paths into what git can actually be handed, returning
    (present, deletions, unmatched). Existence matters because git treats
    the two cases differently: a path that is gone is only a valid
    pathspec if git already tracks it, and one unmatched pathspec aborts
    the entire `git add` (taking the commit with it).

    Read-only — safe to call from the dry run.
    """
    present = [p for p in paths if os.path.exists(p)]
    missing = [p for p in paths if not os.path.exists(p)]
    deletions, unmatched = [], list(missing)

    if missing:
        # One batched call; git echoes back only the paths it tracks,
        # which are the genuine deletions worth staging.
        tracked = run(["git", "ls-files", "-z", "--", *missing], cwd)
        if tracked.returncode == 0:
            for rel in tracked.stdout.split("\0"):
                if rel.strip():
                    deletions.append(os.path.normpath(os.path.join(cwd, rel)))
            unmatched = [p for p in missing if p not in deletions]

    return present, deletions, unmatched


def stage_paths(paths, cwd):
    """
    Stage `paths`, returning (result, targets). The targets matter to the
    caller: every later git step must be scoped to them, or it silently
    widens to the whole index.
    """
    present, deletions, _ = resolve_stage_set(paths, cwd)
    targets = present + deletions
    if not targets:
        return None, []
    return run(["git", "add", "-A", "--", *targets], cwd), targets


def staged_elsewhere(targets, repo_root):
    """
    Paths sitting in the index that we did NOT stage — typically staged by
    hand before /commit ran. A pathspec-scoped commit leaves them alone.
    """
    result = run(["git", "diff", "--cached", "--name-only"], repo_root)
    if result.returncode != 0:
        return []
    ours = {os.path.normpath(_rel(p, repo_root)) for p in targets}
    return [
        line for line in result.stdout.splitlines()
        if line.strip() and os.path.normpath(line) not in ours
    ]


def in_merge(repo_root):
    """
    git refuses a partial (pathspec) commit mid-merge: 'cannot do a partial
    commit during a merge'. There the whole index is the commit, by design.
    """
    return run(["git", "rev-parse", "--verify", "-q", "MERGE_HEAD"], repo_root).returncode == 0


def _rel(path, root):
    try:
        return os.path.relpath(path, root)
    except ValueError:
        return path


def build_dry_run_report(message, session_id, transcript_path, repo_root, scan):
    """
    Describe exactly what a real `/commit` would do, running every
    read-only step for real (transcript parse, out-of-repo filter,
    `git ls-files`, `git status`) and stopping before `add`/`commit`.
    """
    out = ["/commit --dry-run — nothing was staged or committed.", ""]
    out.append(f"repo root:  {repo_root}")
    out.append(f"transcript: {transcript_path or '(none supplied)'}")
    out.append(f"message:    {message}")
    out.append(f"session:    {session_id}")
    out.append("")

    if scan is None:
        out.append("Transcript unreadable or absent, so there is no")
        out.append("session-derived file list. A real /commit would FALL BACK")
        out.append("to `git add -A` and stage every dirty file in the repo:")
        out.append("")
        status = run(["git", "status", "--porcelain"], repo_root)
        out.append(status.stdout.rstrip() or "  (working tree is clean)")
        return "\n".join(out)

    out.append(
        f"parsed {scan.records} records, found {scan.write_calls} write tool call(s)"
    )

    # Surface the discards. These are the filters that otherwise make the
    # hook look like it has silently lost a file.
    if scan.failed_paths:
        out.append("")
        out.append(f"dropped — tool call reported an error ({len(scan.failed_paths)}):")
        out += [f"  {_rel(p, repo_root)}" for p in scan.failed_paths]
    if scan.outside:
        out.append("")
        out.append(f"dropped — outside this repo ({len(scan.outside)}):")
        out += [f"  {p}" for p in scan.outside]

    if not scan.paths:
        out.append("")
        out.append("No in-repo writes found — a real /commit would FALL BACK")
        out.append("to `git add -A`.")
        return "\n".join(out)

    present, deletions, unmatched = resolve_stage_set(scan.paths, repo_root)

    if unmatched:
        out.append("")
        out.append(
            f"dropped — gone from disk and untracked ({len(unmatched)}), "
            "created then deleted:"
        )
        out += [f"  {_rel(p, repo_root)}" for p in unmatched]

    targets = present + deletions
    out.append("")
    out.append(f"would stage ({len(targets)}):")
    for p in present:
        out.append(f"  {_rel(p, repo_root)}")
    for p in deletions:
        out.append(f"  {_rel(p, repo_root)}  [deletion]")

    # Anything already in the index that isn't ours. The commit is
    # pathspec-scoped precisely so these are left alone — an unscoped
    # `git commit` would sweep every one of them into the commit.
    merging = in_merge(repo_root)
    others = staged_elsewhere(targets, repo_root)
    if others:
        out.append("")
        if merging:
            out.append(f"already in the index ({len(others)}) — WILL BE COMMITTED:")
            out += [f"  {p}" for p in others]
            out.append("  (mid-merge: git forbids a partial commit, so the")
            out.append("   whole index goes in. Finish or abort the merge first.)")
        else:
            out.append(f"already in the index ({len(others)}) — left alone:")
            out += [f"  {p}" for p in others]

    # Whether those paths actually differ from HEAD is the other half of
    # the answer; edited-then-reverted files stage to nothing.
    out.append("")
    if targets:
        status = run(["git", "status", "--porcelain", "--", *targets], repo_root)
        if status.stdout.strip():
            out.append("pending vs HEAD (git status --porcelain):")
            out.append(status.stdout.rstrip())
        else:
            out.append("pending vs HEAD: NONE — these paths already match HEAD,")
            out.append("so a real /commit would refuse with 'nothing to commit'.")

    scope = "" if merging else f" -- <{len(targets)} path(s) above>"
    out.append("")
    out.append("would run:")
    out.append(f"  git add -A -- <{len(targets)} path(s) above>")
    out.append(
        f'  git commit -m "{message}" -m "Claude-session: {session_id}"{scope}'
    )
    return "\n".join(out)


def cli_main(argv):
    """
    Debug entry point, bypassing the hook protocol entirely:

        python commit_user_prompt_submit_hook.py --transcript <path> [--cwd <dir>]

    Always a dry run, so it can be pointed at any historical transcript
    without touching a repo. Prints to stdout and exits 0.
    """
    args = {"--transcript": "", "--cwd": os.getcwd(), "--message": "(dry run)"}
    key = None
    for token in argv:
        if token in args:
            key = token
        elif token in DRY_RUN_FLAGS:
            continue
        elif key:
            args[key] = token
            key = None
        else:
            sys.stderr.write(f"unexpected argument: {token}\n")
            sys.exit(64)

    cwd = args["--cwd"]
    toplevel = run(["git", "rev-parse", "--show-toplevel"], cwd)
    repo_root = (
        os.path.normpath(toplevel.stdout.strip())
        if toplevel.returncode == 0 and toplevel.stdout.strip()
        else cwd
    )

    scan = _scan_writes(args["--transcript"], repo_root)
    print(
        build_dry_run_report(
            args["--message"], "(cli)", args["--transcript"], repo_root, scan
        )
    )
    sys.exit(0)


def _force_utf8_output():
    """
    Hook output is non-ASCII (em dashes) and Windows consoles default to
    cp1252, which mangles it and can raise UnicodeEncodeError mid-write.
    Reconfigure both streams; no-op on Python < 3.7 or odd stream types.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main():
    _force_utf8_output()

    # Any argv at all means someone is debugging from a shell, not Claude
    # Code invoking the hook over stdin.
    if len(sys.argv) > 1:
        cli_main(sys.argv[1:])
        return

    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "")
    cwd = payload.get("cwd", ".")
    session_id = payload.get("session_id", "unknown")
    transcript_path = payload.get("transcript_path", "")

    match = COMMIT_PATTERN.match(prompt.strip())
    if not match:
        allow()
        return

    dry_run, message = split_flags(match.group(1) or "")
    if not message:
        finish("Usage: /commit [--dry-run] <message>", ok=False)
        return

    toplevel = run(["git", "rev-parse", "--show-toplevel"], cwd)
    if toplevel.returncode != 0:
        finish("Not a git repository — nothing to commit.", ok=False)
        return
    repo_root = os.path.normpath(toplevel.stdout.strip()) or cwd

    if dry_run:
        scan = _scan_writes(transcript_path, repo_root)
        finish(
            build_dry_run_report(
                message, session_id, transcript_path, repo_root, scan
            ),
            ok=True,
        )
        return

    changed = get_changed_paths(transcript_path, repo_root)

    if changed:
        add_result, targets = stage_paths(changed, repo_root)
        if add_result is None:
            finish(
                "Claude edited files this session, but none of them still "
                "exist or are tracked — nothing to stage.",
                ok=False,
            )
            return
    else:
        # No session-derived list (e.g. transcript unavailable): fall back
        # to staging everything, matching the previous behaviour.
        add_result, targets = run(["git", "add", "-A"], repo_root), []

    if add_result.returncode != 0:
        finish(f"git add failed:\n{add_result.stderr}", ok=False)
        return

    # Scope every remaining step to our own paths. Both `git diff --cached`
    # and `git commit` default to the WHOLE INDEX, which may already hold
    # files the user staged by hand before /commit ran — staging selectively
    # is pointless if the commit then sweeps them all up anyway.
    # Mid-merge is the exception: git forbids partial commits there.
    scope = ["--", *targets] if targets and not in_merge(repo_root) else []

    staged = run(["git", "diff", "--cached", "--name-only", *scope], repo_root)
    if not staged.stdout.strip():
        finish("Nothing to commit — working tree matches HEAD.", ok=False)
        return

    commit_result = run(
        ["git", "commit", "-m", message, "-m", f"Claude-session: {session_id}", *scope],
        repo_root,
    )

    if commit_result.returncode != 0:
        finish(f"git commit failed:\n{commit_result.stderr}", ok=False)
        return

    sha = run(["git", "rev-parse", "--short", "HEAD"], repo_root).stdout.strip()
    count = len(staged.stdout.strip().splitlines())
    held_back = len(staged_elsewhere(targets, repo_root)) if scope else 0
    suffix = f", {held_back} left staged" if held_back else ""
    finish(f"Committed {sha} ({count} file(s){suffix}): {message}", ok=True)


if __name__ == "__main__":
    main()