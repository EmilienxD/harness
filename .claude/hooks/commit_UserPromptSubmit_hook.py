#!/usr/bin/env python3
"""
Claude Code UserPromptSubmit hook for `/commit [--dry] [--ai] <message>`.

Runs BEFORE the prompt is sent to the model. If the prompt matches
`/commit ...`, this script stages + commits changes itself and rejects the
prompt with a status string, which Claude Code shows directly to the user.
The main model is never called for this turn.

`--ai` is the one exception to "zero model calls": it makes <message>
optional by generating one from the staged diff via a single, cheap
Gemini call. That is a direct API call to a small model, not a Claude turn,
so the session history is never re-sent.

Any other prompt is let through untouched.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple

COMMIT_PATTERN = re.compile(r"^/commit(?:\s+(.*))?$", re.DOTALL)

# Leading flags accepted before the commit message.
DRY_FLAGS = {"--dry", "-n"}
AI_FLAGS = {"--ai"}

Flags = namedtuple("Flags", "dry use_ai")

# Tools whose invocation means "this file was modified on disk".
# Read/Grep/Glob are excluded: they touch nothing.
WRITE_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit", "Update"}

# Result of reading a transcript. Everything the dry run needs to explain
# itself, including the paths that were deliberately discarded -- those are
# the silent filters, and silent filters are what make a hook baffling.
WriteScan = namedtuple(
    "WriteScan",
    "paths outside failed_paths ignored records write_calls unresolved",
)


def split_flags(rest: str):
    """
    Peel recognised flags off the front of `/commit ...`, returning
    (Flags, message). Flags must precede the message, otherwise a message
    legitimately containing the word --dry would be misread as a flag.

    With --ai the message is optional; whatever text follows becomes
    steering guidance for the generator rather than the message itself.
    """
    dry = use_ai = False
    while rest:
        stripped = rest.lstrip()
        if not stripped:
            break
        parts = stripped.split(None, 1)
        token = parts[0]
        if token in DRY_FLAGS:
            dry = True
        elif token in AI_FLAGS:
            use_ai = True
        else:
            break
        rest = parts[1] if len(parts) > 1 else ""
    return Flags(dry, use_ai), rest.strip()


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


# ---------------------------------------------------------------------------
# Files changed by shell commands
#
# Claude edits files without the Edit/Write tools more often than it should: a
# heredoc redirect, `sed -i`, an inline `python - <<'PY'` calling open(p, "w"),
# a PowerShell Set-Content. Those changes are as committable as the tool-driven
# ones, so their targets are read off the command string too. Without this a
# session that mixed both stages only the tool writes -- the Bash-written files
# are never handed to `git add` and quietly miss the commit. (`prefer-edit-tool`
# nudges Claude out of the habit, but /commit cannot assume it is installed.)
#
# Where a write is recognisable but its target is not -- `git apply`, a path
# held in a variable, a glob -- the command is reported as unresolved and the
# hook widens to staging every change in the repo. Widening is visible and
# recoverable; dropping a file from the commit is neither.
# ---------------------------------------------------------------------------

SHELL_TOOLS = {"Bash", "PowerShell"}

# Redirect sinks that discard output instead of naming a file.
NULL_SINKS = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty",
              "nul", "null", "$null", "con", "-"}

# `> path` / `>> path`. The operator has to start a word, which is how shell
# redirects are written and how the things that only look like one are ruled
# out: `2>` and other fd captures, `&>`, and the `->`, `=>`, `<div>` that turn
# up inside quoted source code.
REDIRECT = re.compile(
    r"(?:^|(?<=\s))>>?\s*(?![&>|])(\"[^\"]*\"|'[^']*'|[^\s;&|)`<>]+)"
)

# `<<'PY'` ... `PY`: the body is data, so it is dropped before the command
# itself is parsed. The literal paths inside it are still read (see below) --
# an inline script writing a file is the whole point.
HEREDOC_OPEN = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")

# Interpreter writes whose target is a literal in the source.
QUOTED_TARGETS = [
    # python: open("f", "w"), Path("f").write_text(...)
    re.compile(r"open\s*\(\s*(['\"])(?P<path>[^'\"]+)\1\s*,\s*['\"][rwaxbt+]*[wax+]"),
    re.compile(r"Path\s*\(\s*(['\"])(?P<path>[^'\"]+)\1\s*\)\s*\.\s*write_(?:text|bytes)"),
    # node: fs.writeFileSync("f", ...), Bun.write("f", ...), Deno.writeTextFile("f", ...)
    re.compile(
        r"(?:writeFile|appendFile|createWriteStream|outputFile)(?:Sync)?"
        r"\s*\(\s*(['\"`])(?P<path>[^'\"`]+)\1"
    ),
    re.compile(r"(?:Bun\.write|Deno\.write\w*)\s*\(\s*(['\"`])(?P<path>[^'\"`]+)\1"),
    # powershell / dd
    re.compile(
        r"\[(?:System\.)?IO\.File\]::(?:Write|Append)\w*\s*\(\s*(['\"])(?P<path>[^'\"]+)\1",
        re.IGNORECASE,
    ),
    re.compile(r"\bof=(?P<path>[^\s;&|)`]+)"),
]

# "Something here wrote a file", used only to tell a write whose target we
# failed to read from an ordinary command with no target to read. Kept
# narrower than a nudge-hook's version would be: a false positive here stages
# the whole repo, so a bare `.write(` is deliberately not on the list.
WRITE_SIGNALS = re.compile(
    r"(?:^|[;&|(`\n{])\s*(?:sudo\s+)?(?:tee|patch|dd|truncate|mv|cp|rm|touch)\b"
    r"|\bgit\s+apply\b"
    r"|(?:^|[;&|(`\n{]|\b(?:do|then|else|xargs|exec)\b)\s*(?:sudo\s+)?"
    r"(?:sed|perl|ruby)\b(?=[^;&|`\n]*(?:\s-[A-Za-z]*i\b|\s--in-place))"
    r"|(?:g?awk)\b(?=[^;&|`\n]*inplace)"
    r"|\bopen\s*\([^)]*['\"][rwaxbt+]*[wax+][rwaxbt+]*['\"]"
    r"|\.write_(?:text|bytes)\s*\(|\.writelines\s*\("
    r"|\b(?:writeFile|appendFile|createWriteStream|outputFile)(?:Sync)?\s*\("
    r"|\bBun\.write\s*\(|\bDeno\.write\w*\s*\("
    r"|\b(?:Set-Content|Add-Content|Out-File|Export-Csv|Export-Clixml)\b",
    re.IGNORECASE,
)

SEGMENT_SPLIT = re.compile(r"[;&|\n]+")
LAUNCHERS = {"sudo", "xargs", "time", "nohup", "env", "command"}
PS_WRITE_CMDLETS = {"set-content", "add-content", "out-file", "export-csv", "export-clixml"}
PS_PATH_FLAGS = {"-path", "-filepath", "-literalpath"}
VALUE_FLAGS = {"-e", "-f", "--expression", "--file"}
EXPRESSION_FLAG = re.compile(r"^-[A-Za-z]*[ef][A-Za-z]*$|^--(?:expression|file)=")
# A target we can see but cannot name: $VAR, %VAR%, a glob.
COMPUTED = re.compile(r"[$*?`]|%\w+%")
# `cd sub && sed -i ... f`: a relative target in the command is relative to
# somewhere this hook can't know, so it can't be resolved against the record's
# cwd the way every other path is.
CHANGES_DIR = re.compile(r"(?:^|[;&|(`\n{])\s*(?:cd|pushd|popd|Set-Location)\b", re.IGNORECASE)
NUMERIC = re.compile(r"^[\d.]+$")
WORD_CHAR = re.compile(r"\w")
PATHISH = re.compile(r"[./\\]")


def _clean_token(token: str) -> str:
    token = token.strip()
    if len(token) > 1 and token[0] == token[-1] and token[0] in "\"'":
        token = token[1:-1]
    return token.strip()


def _strip_heredocs(command: str) -> str:
    """Drop heredoc bodies, keeping the header lines that carry the redirect."""
    kept, terminator = [], None
    for line in command.splitlines():
        if terminator is not None:
            if line.strip() == terminator:
                terminator = None
            continue
        kept.append(line)
        opener = None
        for opener in HEREDOC_OPEN.finditer(line):
            pass
        if opener:
            terminator = opener.group(2)
    return "\n".join(kept)


def _tokenize(segment: str):
    """Shell-ish tokens. posix=False keeps Windows backslashes intact."""
    try:
        tokens = shlex.split(segment, posix=False)
    except ValueError:
        tokens = segment.split()
    return [_clean_token(t) for t in tokens if t.strip()]


def _bare_operands(args):
    return [a for a in args if not a.startswith("-")]


def _in_place(args) -> bool:
    """An -i flag anywhere: `-i`, `-i.bak`, `perl -pi -e`, `awk -i inplace`."""
    return any(
        arg == "--in-place" or arg == "inplace"
        or (arg.startswith("-") and not arg.startswith("--") and "i" in arg.lstrip("-"))
        for arg in args
    )


def _editor_operands(name, args):
    """File operands of an in-place sed/perl/awk, script and flag values dropped."""
    value_flags = set(VALUE_FLAGS) | ({"-i", "-v"} if name in ("awk", "gawk") else set())
    operands, skip = [], False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg.startswith("-"):
            skip = arg in value_flags
            continue
        operands.append(arg)
    # Without an -e/-f flag the first bare operand is the inline script.
    if operands and not any(EXPRESSION_FLAG.match(a) for a in args):
        operands = operands[1:]
    return operands


def _ps_operands(args):
    """The file a PowerShell write cmdlet targets: -Path, else the first
    operand shaped like one (`-Encoding utf8` must not read as a path)."""
    named, take_next = [], False
    for arg in args:
        if take_next:
            named.append(arg)
            take_next = False
        elif arg.lower() in PS_PATH_FLAGS:
            take_next = True
    if named:
        return named
    for arg in _bare_operands(args):
        if PATHISH.search(arg):
            return [arg]
    return []


def _operand_targets(shell):
    """(paths, unreadable) for commands that name their target as an operand."""
    paths, unreadable = [], False
    for segment in SEGMENT_SPLIT.split(shell):
        tokens = _tokenize(segment)
        while tokens and tokens[0].lower() in LAUNCHERS:
            tokens = tokens[1:]
        if not tokens:
            continue
        name = os.path.basename(tokens[0]).lower()
        args = tokens[1:]

        if name == "tee":
            paths += _bare_operands(args)
        elif name in ("sed", "perl", "ruby", "awk", "gawk"):
            if _in_place(args):
                paths += _editor_operands(name, args)
        elif name in ("mv", "cp", "rm", "touch"):
            # Both ends of a move matter: the source is a deletion to stage,
            # the destination a new file.
            paths += _bare_operands(args)
        elif name in PS_WRITE_CMDLETS:
            found = _ps_operands(args)
            paths += found
            unreadable = unreadable or not found
        elif name == "patch" or (name == "git" and args[:1] == ["apply"]):
            # The paths live inside the diff, not the command line.
            unreadable = True
    return paths, unreadable


def shell_write_targets(command):
    """
    (paths, resolved) for one shell command, paths exactly as written.

    Read off the string: redirect targets, `tee`/`mv`/`cp`/`rm`/`touch`
    operands, the file operands of an in-place `sed`/`perl`/`awk`, and literal
    paths inside inline python/node/PowerShell writes.

    `resolved` is False when the command is recognisably a write but nothing
    usable came out of it -- `git apply`, a target held in a variable, a glob
    -- which tells the caller to widen instead of committing a subset. A
    command mixing a literal target with a computed one also reads as
    unresolved: the literal alone would be a silent partial answer.
    """
    if not isinstance(command, str) or not command.strip():
        return [], True

    shell = _strip_heredocs(command)
    raw, unreadable = _operand_targets(shell)

    for match in REDIRECT.finditer(shell):
        raw.append(_clean_token(match.group(1)))

    # The inline-script patterns run against the full command: the write they
    # are looking for is inside the heredoc body that was just stripped.
    for pattern in QUOTED_TARGETS:
        raw += [_clean_token(m.group("path")) for m in pattern.finditer(command)]

    paths, seen = [], set()
    for path in raw:
        low = path.lower()
        if not path or path in seen or low in NULL_SINKS or low.startswith("/dev/"):
            continue
        # `x >> 1` and `if a >= 5` from a heredoc'd script that survived.
        if NUMERIC.match(path) or not WORD_CHAR.search(path):
            continue
        if COMPUTED.search(path):
            unreadable = True
            continue
        seen.add(path)
        paths.append(path)

    # A leading slash counts as absolute whatever the host platform thinks:
    # these commands ran in a shell, not through ntpath.
    if paths and CHANGES_DIR.search(shell) and any(
        not (os.path.isabs(p) or p.startswith(("/", "\\"))) for p in paths
    ):
        unreadable = True

    if unreadable:
        return paths, False
    if not paths and WRITE_SIGNALS.search(command):
        return [], False
    return paths, True


def _scan_writes(transcript_path: str, repo_root: str):
    """
    Parse the session transcript for file-writing tool_use entries and
    return a WriteScan describing what was found and what was discarded.
    Returns None if the transcript can't be read at all.

    Notes on the transcript format, which the parsing below relies on:

    - Write tool calls are `tool_use` blocks inside `assistant` records.
    - Bash/PowerShell blocks are scanned too: a heredoc, `sed -i` or inline
      python writes real files, and staging only the Edit/Write ones would
      commit a subset of the session's work.
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
    unresolved = []  # (tool_use_id, command) for shell writes with no readable target
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

                name = block.get("name")
                if name not in WRITE_TOOLS and name not in SHELL_TOOLS:
                    continue

                tool_input = block.get("input")
                if not isinstance(tool_input, dict):
                    continue

                tool_use_id = block.get("id") or f"_anon{len(calls)}"

                if name in SHELL_TOOLS:
                    command = tool_input.get("command")
                    targets, resolved = shell_write_targets(command)
                    for target in targets:
                        calls.append((tool_use_id, _abs(target, record_cwd)))
                    if not resolved:
                        unresolved.append((tool_use_id, command))
                    continue

                raw_path = tool_input.get("file_path") or tool_input.get("notebook_path")
                if not isinstance(raw_path, str) or not raw_path.strip():
                    continue

                calls.append((tool_use_id, _abs(raw_path, record_cwd)))
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

    # Drop gitignored paths next -- .issues-gateway/ scratch, build output,
    # and the like, which Claude touching does not make commit-worthy.
    paths, ignored = filter_ignored(inside, repo_root)

    # A command that failed wrote nothing, so it is not an unreadable write.
    unreadable = []
    for tool_use_id, command in unresolved:
        text = " ".join(str(command).split())
        if tool_use_id not in failed_ids and text and text not in unreadable:
            unreadable.append(text)

    return WriteScan(
        paths=paths,
        outside=outside,
        failed_paths=failed_paths,
        ignored=ignored,
        records=records,
        write_calls=len(calls),
        unresolved=unreadable,
    )


def _abs(path: str, cwd: str) -> str:
    """A path as written in a tool call, resolved against that call's cwd."""
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


def changed_paths(scan):
    """
    The paths a scan says to stage, or None for "no usable list" -- which
    tells the caller to stage everything instead. None covers an unreadable
    transcript, a session with no writes at all, and a shell write whose
    target could not be read: staging wide is visible in the result, staging
    a subset of what changed is not.
    """
    if scan is None or scan.unresolved:
        return None
    return scan.paths or None


def get_changed_paths(transcript_path: str, repo_root: str):
    """
    Absolute paths Claude wrote to this session, so we only stage what it
    actually changed rather than every dirty file in the repo.
    """
    return changed_paths(_scan_writes(transcript_path, repo_root))


def _is_within(path: str, root: str) -> bool:
    try:
        return not os.path.relpath(path, root).startswith(os.pardir)
    except ValueError:
        # Different drives on Windows.
        return False


def run(cmd, cwd, input=None):
    return subprocess.run(cmd, cwd=cwd, input=input, capture_output=True, text=True)


def finish(message: str):
    """
    Reject the prompt either way (success or failure) so it never reaches
    the model. `message` is what the user sees in place of a response.
    Exit code 2 is what makes Claude Code treat stderr as the rejection
    reason for a UserPromptSubmit hook.
    """
    sys.stderr.write(f"\n\n{message.strip()}")
    sys.exit(2)


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

    Read-only -- safe to call from the dry run.
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


def filter_ignored(paths, cwd):
    """
    Split `paths` into (kept, ignored), where `ignored` matches a gitignore
    rule -- `.issues-gateway/` scratch, build output, and the like, which
    Claude touching does not make commit-worthy.

    `git add -A -- <ignored untracked path>` exits 1, so one ignored path
    would otherwise sink the whole commit with a spurious `git add failed`.

    `git check-ignore` exits 0 when anything matches, 1 when nothing does,
    >=128 on a real error. Anything else (not a repo, old git, ...) keeps
    every path, which degrades to the pre-filter behaviour.
    """
    if not paths:
        return paths, []
    result = run(["git", "check-ignore", "--stdin", "-z"], cwd, input="\0".join(paths))
    if result.returncode == 1:
        return paths, []
    if result.returncode != 0:
        return paths, []
    ignored = {os.path.normpath(p) for p in result.stdout.split("\0") if p.strip()}
    kept = [p for p in paths if os.path.normpath(p) not in ignored]
    return kept, [p for p in paths if os.path.normpath(p) in ignored]


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
    Paths sitting in the index that we did NOT stage -- typically staged by
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


def _shorten(text, limit=90):
    """One line of a command, for reports where the point is which command."""
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# AI commit message generation (--ai)
#
# One synchronous call to a small Gemini model. Everything below is inert
# unless --ai is passed. The REST call uses only Python's standard library,
# so generated messages need an API key but no separately installed package.
# ---------------------------------------------------------------------------

AI_MODEL_DEFAULT = "gemini-3.5-flash-lite"
AI_MODEL = os.environ.get("COMMIT_AI_MODEL", AI_MODEL_DEFAULT)
AI_TIMEOUT_SECONDS = 45
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
GEMINI_BASE_URL = (
    os.environ.get("COMMIT_AI_BASE_URL") or DEFAULT_GEMINI_BASE_URL
).rstrip("/")

# Character budgets for the prompt. The diff is the ground truth so it gets
# the lion's share; session narrative is supporting evidence for *why*.
# These are the *preferred* sizes; token_budget() below shrinks them when the
# model's per-minute token limit is tighter than they are.
DIFF_BUDGET = 40000
PER_FILE_FLOOR = 800
CONTEXT_BUDGET = 12000
NEW_FILE_BUDGET = 4000
LOG_SAMPLE = 15

# --- Per-minute input-token limits -----------------------------------------
#
# The free Gemini tier caps tokens *per minute*, not just requests per minute.
# Request rate is a non-issue here (one call per commit), but the TPM cap is
# effectively a context limit: models advertise a 1M-token context while the
# free tier will reject a single request that exceeds ~200k tokens in a
# minute. So the prompt is sized against the TPM number, not the context
# window.
#
# Keys are Gemini model ids; values are input tokens per minute on the free
# tier, from the limits page in Google AI Studio
# (https://ai.google.dev/gemini-api/docs/rate-limits). An unlisted model falls
# back to DEFAULT_TPM_LIMIT. A 0 entry marks a model with NO free-tier quota
# at all (0 RPM / 0 TPM / 0 RPD -- paid tiers only): generate_commit_message
# refuses outright and points the user at a free-tier model, so nobody burns
# an API round-trip on a request Google is guaranteed to reject.
MODEL_TPM_LIMITS = {
    "gemini-2.5-flash-lite": 250_000,
    "gemini-2.5-pro": 0,
    "gemini-3-flash": 250_000,
    "gemini-3.1-pro": 0,
    "gemini-3.1-flash-lite": 250_000,
    "gemini-3.5-flash": 250_000,
    "gemini-3.5-flash-lite": 250_000,
    "gemini-3.6-flash": 250_000,
    "gemini-3.7-flash": 250_000,
}
DEFAULT_TPM_LIMIT = 200_000

# Chars per token, deliberately pessimistic. Real Gemini tokenisation of code
# and diffs lands near 3.5-4 chars/token; assuming fewer chars per token makes
# the estimate over-count tokens, which is the safe direction to be wrong in.
CHARS_PER_TOKEN = 3.0

# Tokens the request costs beyond the user prompt: system instruction, the
# response schema, and the completion itself (which counts against the same
# per-minute budget).
OVERHEAD_TOKENS = 2000

# Fraction of the limit left unused, absorbing tokenisation estimate error and
# any other call that happened to land in the same minute.
TPM_SAFETY_FRACTION = 0.20

# Floors: below these the prompt stops being worth sending at all, so a
# misconfigured tiny limit still leaves a prompt worth sending; the hard cap
# in _build_prompt is what guarantees the ceiling if even these don't fit.
MIN_DIFF_BUDGET = 4000
MIN_CONTEXT_BUDGET = 1000

# Chars the prompt spends on everything that is neither diff nor narrative:
# branch line, commit-log sample, file summary, section headers, guidance.
FIXED_SECTION_CHARS = 6000

PromptBudget = namedtuple("PromptBudget", "total diff context tpm model")

# Generated files: huge diffs, zero signal. Listed in the file summary so the
# model knows they changed, but their bodies never reach the prompt.
NOISY_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Cargo.lock", "uv.lock", "composer.lock", "go.sum", "Gemfile.lock",
}
NOISY_SUFFIXES = (".min.js", ".min.css", ".map", ".lock", ".pyc", ".ipynb")

# Anything key-shaped is stripped before the transcript leaves the machine.
# The session narrative is user prose, and users paste secrets into prose.
SECRET_PATTERNS = [
    (re.compile(r"AIza[0-9A-Za-z_\-]{20,}"), "[REDACTED]"),
    (re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), "[REDACTED]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), "[REDACTED]"),
    (
        re.compile(
            r"(?i)\b(api[_\-]?key|secret|token|password|passwd|bearer)"
            r"(\b[\"']?\s*[:=]\s*[\"']?)(\S{8,})"
        ),
        r"\1\2[REDACTED]",
    ),
]

# Resolution order for the API key. Live env vars come first, matching the
# conventional Gemini setup so anyone who already has a key configured needs
# to do nothing. Then the `env` dict of each settings file -- Claude
# Code's own mechanism for handing environment variables to hooks, and where a
# user would reasonably expect to put this. Then a bare key file, for a secret
# that outlives shells and is trivially easy to keep out of git.
KEY_ENV_VARS = ("GEMINI_API_KEY", "GOOGLE_API_KEY")
KEY_FILE_NAME = "commit-ai.key"
# Most specific first, mirroring Claude Code's own settings precedence.
SETTINGS_NAMES = ("settings.local.json", "settings.json")


def _claude_dirs(repo_root):
    """Every `.claude` directory that could hold a key, nearest scope first.

    `CLAUDE_PROJECT_DIR` is set by Claude Code itself and is authoritative when
    present; `repo_root` covers the standalone-CLI case where it is not.
    """
    candidates = []
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if project:
        candidates.append(os.path.join(project, ".claude"))
    if repo_root:
        candidates.append(os.path.join(repo_root, ".claude"))
    candidates.append(os.path.join(os.path.expanduser("~"), ".claude"))

    seen, out = set(), []
    for path in candidates:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _settings_env(path):
    """The `env` dict from a settings file, or {} if unreadable or absent.

    A malformed settings file is not this hook's problem to report: Claude Code
    surfaces that far more clearly than a commit failure would.
    """
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    env = data.get("env") if isinstance(data, dict) else None
    return env if isinstance(env, dict) else {}


def _read_key_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return None


def key_setup_help(repo_root):
    """Setup instructions with this project's real paths filled in."""
    local = os.path.join(repo_root or ".", ".claude", "settings.local.json")
    key_file = os.path.join(os.path.expanduser("~"), ".claude", KEY_FILE_NAME)
    return f"""No Google AI Studio API key found. Get one (the free tier is ample
for commit messages) at https://aistudio.google.com/apikey then pick one:

  1. Claude Code's own env passthrough -- {local}
       {{"env": {{"GEMINI_API_KEY": "your-key-here"}}}}
     settings.local.json is per-machine and gitignored by this tool's installer.

  2. Key file -- one line, nothing else, no restart needed:
       {key_file}
     Or .claude/{KEY_FILE_NAME} inside this repo, also gitignored for you.

  3. Environment variable -- shared with every other Gemini tool:
       setx GEMINI_API_KEY "your-key-here"        (Windows, new shells only)
       export GEMINI_API_KEY="your-key-here"      (add to ~/.bashrc / ~/.zshrc)

Checked in the order: live environment, then each .claude/settings*.json `env`,
then each .claude/{KEY_FILE_NAME} -- project scope before user scope throughout.

Do NOT paste the key into a Claude prompt: prompts are written verbatim to the
session transcript. Prefer settings.local.json over a committed settings.json.

Restart Claude Code after editing settings.json or setting an env var."""


class AiError(Exception):
    """A user-facing failure that must abort the commit rather than guess."""


AiMessage = namedtuple("AiMessage", "subject body reasoning model source")


def find_api_key(repo_root=None):
    """Return (key, where_it_came_from), or (None, None)."""
    for var in KEY_ENV_VARS:
        value = (os.environ.get(var) or "").strip()
        if value:
            return value, f"${var}"

    dirs = _claude_dirs(repo_root)
    for directory in dirs:
        for name in SETTINGS_NAMES:
            path = os.path.join(directory, name)
            env = _settings_env(path)
            for var in KEY_ENV_VARS:
                value = str(env.get(var) or "").strip()
                if value:
                    return value, f"{path} (env.{var})"

    for directory in dirs:
        path = os.path.join(directory, KEY_FILE_NAME)
        value = _read_key_file(path)
        if value:
            return value, path

    return None, None


def redact(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _is_noisy(rel_path: str) -> bool:
    name = os.path.basename(rel_path)
    return name in NOISY_NAMES or rel_path.endswith(NOISY_SUFFIXES)


def _diff_scope(targets):
    return ["--", *targets] if targets else []


def _untracked(repo_root, targets):
    """
    Untracked paths within scope. Needed only for the dry run: nothing is
    staged there, and `git diff HEAD` cannot see a file git doesn't know.
    """
    result = run(
        ["git", "status", "--porcelain", "-z", *_diff_scope(targets)], repo_root
    )
    if result.returncode != 0:
        return []
    found = []
    for entry in result.stdout.split("\0"):
        if entry.startswith("?? "):
            found.append(os.path.normpath(os.path.join(repo_root, entry[3:])))
    return found


def _synth_new_file(path, repo_root):
    """
    A unified-diff-shaped block for an untracked file, so the dry run shows
    the model the same thing a real staged diff would.
    """
    rel = _rel(path, repo_root).replace(os.sep, "/")
    header = (
        f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n"
        f"--- /dev/null\n+++ b/{rel}\n"
    )
    if _is_noisy(rel):
        return header + "@@ generated file, contents omitted @@\n"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            body = fh.read(NEW_FILE_BUDGET + 1)
    except OSError:
        return header + "@@ unreadable @@\n"
    if "\0" in body:
        return header + "@@ binary, contents omitted @@\n"
    truncated = len(body) > NEW_FILE_BUDGET
    lines = body[:NEW_FILE_BUDGET].splitlines()
    out = header + f"@@ -0,0 +1,{len(lines)} @@\n"
    out += "".join("+" + line + "\n" for line in lines)
    return out + ("+... [truncated]\n" if truncated else "")


def collect_file_summary(repo_root, targets, staged):
    """Compact `+added -deleted  path` list -- complete even when the diff isn't."""
    scope = _diff_scope(targets)
    base = ["git", "diff", "--numstat", "--no-color", "-M"]
    base += ["--cached"] if staged else ["HEAD"]
    result = run([*base, *scope], repo_root)

    rows = []
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                added, deleted, path = parts[0], parts[1], parts[-1]
                mark = "binary" if added == "-" else f"+{added} -{deleted}"
                rows.append(f"  {mark:<14} {path}")

    if not staged:
        for path in _untracked(repo_root, targets):
            rows.append(f"  {'new file':<14} {_rel(path, repo_root)}")

    return "\n".join(rows)


def collect_diff(repo_root, targets, staged):
    """
    The change about to be committed, as a unified diff.

    `staged=True` reads the index, which is exactly what git will commit.
    `staged=False` is the dry run: compare the working tree to HEAD and
    synthesise blocks for untracked files, since nothing has been staged.
    """
    scope = _diff_scope(targets)
    base = ["git", "diff", "--no-color", "-M"]
    base += ["--cached"] if staged else ["HEAD"]
    result = run([*base, *scope], repo_root)
    # A repo with no commits yet has no HEAD; everything is a new file.
    text = result.stdout if result.returncode == 0 else ""

    if not staged:
        for path in _untracked(repo_root, targets):
            text += _synth_new_file(path, repo_root)
    return text


def trim_diff(text, budget=DIFF_BUDGET):
    """
    Fit the diff into `budget` chars without letting one enormous file
    swallow the whole allowance -- a global tail would show the model an
    exhaustive lockfile and nothing of the actual feature.
    """
    if not text.strip():
        return ""

    chunks = [c for c in re.split(r"(?m)^(?=diff --git )", text) if c.strip()]
    if not chunks:
        return text[:budget]

    cleaned = []
    for chunk in chunks:
        match = re.match(r"diff --git a/(\S+) b/(\S+)", chunk)
        name = match.group(2) if match else ""
        if name and _is_noisy(name):
            head = chunk.split("\n", 1)[0]
            cleaned.append(
                f"{head}\n@@ generated file, {chunk.count(chr(10))} diff lines omitted @@\n"
            )
        else:
            cleaned.append(chunk)

    if sum(len(c) for c in cleaned) <= budget:
        return "".join(cleaned)

    share = max(PER_FILE_FLOOR, budget // len(cleaned))
    out = []
    for chunk in cleaned:
        if len(chunk) <= share:
            out.append(chunk)
        else:
            dropped = len(chunk) - share
            out.append(chunk[:share] + f"\n... [{dropped} more chars of this file] ...\n")
    joined = "".join(out)
    # Floor times file-count can still overshoot; hard-cap as a last resort.
    hard = budget * 2
    return joined if len(joined) <= hard else joined[:hard] + "\n... [truncated] ...\n"


def _clean_prompt_text(text):
    """Strip the machinery Claude Code injects into user records."""
    text = re.sub(r"(?s)<system-reminder>.*?</system-reminder>", "", text)
    text = re.sub(r"(?s)<local-command-[a-z]+>.*?</local-command-[a-z]+>", "", text)
    text = re.sub(r"(?s)<command-(?:name|message|args)>.*?</command-\w+>", "", text)
    text = re.sub(r"(?s)<local-command-caveat>.*?</local-command-caveat>", "", text)
    return text.strip()


def _truncate(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + " ..."


def collect_session_context(transcript_path, repo_root, budget=CONTEXT_BUDGET):
    """
    A chronological narrative of the session: what the user asked for and
    what was done, in the order it happened. The diff says *what* changed;
    this is the only source for *why*.

    Uses the same transcript reading as _scan_writes -- user records whose
    content is a bare string or a list of blocks, assistant tool_use blocks
    for actions -- rather than guessing at the format.

    Earlier `/commit` invocations become explicit markers: everything above
    the last one is already committed, so the model should describe only
    what follows it while still reading the earlier text as background.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return ""

    events = []
    try:
        for record in _iter_transcript(transcript_path):
            rtype = record.get("type")
            if rtype not in ("user", "assistant") or record.get("isMeta"):
                continue

            message = record.get("message")
            content = message.get("content") if isinstance(message, dict) else None

            if rtype == "user":
                if isinstance(content, str):
                    text = _clean_prompt_text(content)
                elif isinstance(content, list):
                    # A user record carrying only tool_result blocks is
                    # plumbing, not something the person actually said.
                    text = _clean_prompt_text(
                        "\n".join(
                            b.get("text", "")
                            for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        )
                    )
                else:
                    continue
                if not text:
                    continue

                prior = COMMIT_PATTERN.match(text)
                if prior:
                    flags, msg = split_flags(prior.group(1) or "")
                    if not flags.dry:
                        events.append(
                            f"=== ALREADY COMMITTED UP TO HERE: {msg or '(generated)'} ==="
                        )
                    continue
                events.append("USER: " + _truncate(text, 900))
                continue

            for block in _content_blocks(record):
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text = _clean_prompt_text(block.get("text", ""))
                    if text:
                        events.append("ASSISTANT: " + _truncate(text, 260))
                    continue
                if btype != "tool_use":
                    continue

                name = block.get("name", "")
                tool_input = block.get("input")
                if not isinstance(tool_input, dict):
                    continue

                if name in WRITE_TOOLS:
                    raw = tool_input.get("file_path") or tool_input.get("notebook_path")
                    if isinstance(raw, str) and raw.strip():
                        events.append(f"TOOL {name}: {_rel(raw, repo_root)}")
                elif name == "Bash":
                    command = _truncate(tool_input.get("command", ""), 160)
                    note = tool_input.get("description", "")
                    events.append(
                        f"TOOL Bash: {command}" + (f"  ({note})" if note else "")
                    )
                elif name in ("Task", "Agent"):
                    events.append(
                        "TOOL Agent: " + _truncate(tool_input.get("description", ""), 120)
                    )
    except OSError:
        return ""

    # Collapse runs of the same action; ten edits to one file is one fact.
    collapsed = []
    for event in events:
        if collapsed and collapsed[-1][0] == event:
            collapsed[-1][1] += 1
        else:
            collapsed.append([event, 1])
    lines = [e if n == 1 else f"{e}  (x{n})" for e, n in collapsed]

    return redact(_budget_events(lines, budget))


def _budget_events(lines, budget=CONTEXT_BUDGET):
    """
    Fit the narrative into `budget` chars, keeping the highest-signal lines.

    A plain tail is the wrong trade here: user prompts are the only source
    of *intent*, they are small, and they cluster at the START of a session --
    exactly what a tail discards. So prompts and commit markers are admitted
    unconditionally, and tool events fill whatever is left, newest first.
    """
    def is_intent(line):
        return line.startswith("USER:") or line.startswith("===")

    kept = [None] * len(lines)
    used = 0

    for i, line in enumerate(lines):
        if is_intent(line):
            kept[i] = line
            used += len(line) + 1

    # Intent alone can overflow on a very long session; drop oldest prompts.
    for i, line in enumerate(lines):
        if used <= budget:
            break
        if kept[i] is not None:
            kept[i] = None
            used -= len(line) + 1

    for i in range(len(lines) - 1, -1, -1):
        if kept[i] is not None:
            continue
        if used + len(lines[i]) + 1 > budget:
            continue
        kept[i] = lines[i]
        used += len(lines[i]) + 1

    out, gap = [], 0
    for line in kept:
        if line is None:
            gap += 1
            continue
        if gap:
            out.append(f"...[{gap} event(s) omitted]...")
            gap = 0
        out.append(line)
    if gap:
        out.append(f"...[{gap} event(s) omitted]...")
    return "\n".join(out)


SYSTEM_INSTRUCTION = """\
You write git commit messages. You are given the exact diff that is about to \
be committed, a summary of the files it touches, the recent commit log of the \
repository, and a narrative of the coding session that produced the change.

The diff is ground truth. Describe only what it actually shows. If the session \
narrative suggests work that is not in the diff, ignore it -- that work is not \
part of this commit. Never invent a rationale you cannot see evidence for.

The session narrative may contain '=== ALREADY COMMITTED UP TO HERE ===' \
markers. Work above the last marker is already committed; treat it as \
background only and describe only what came after it.

Match the conventions of the recent commit log. If it uses Conventional \
Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, with or \
without a scope), use that form. If it does not, follow whatever style is \
there instead. When the log is empty or inconsistent, default to Conventional \
Commits.

Subject line rules:
- imperative mood ("add", not "added" or "adds")
- at most 72 characters, no trailing period
- concrete and specific; never "update code", "various fixes", or \
"improve quality"

Body rules:
- explain WHY the change was made and any non-obvious decision or trade-off
- do not restate the diff line by line; the reader can read the diff
- hard-wrap at about 72 columns, using '- ' bullets when there are several \
distinct points
- leave the body empty for a genuinely small, self-explanatory change
- never mention Claude, AI, an assistant, or this tool

Output plain text only: no markdown fences, no headings, no quotes around \
the subject."""


def _listed_tpm_limit(name):
    """Normalise the model id and resolve its entry in MODEL_TPM_LIMITS.

    Model ids carry dated and preview suffixes (`gemini-2.5-flash-preview-05-20`)
    that share the base model's limit, so an unlisted id falls back to the
    longest listed id it starts with before falling back to the default.
    """
    name = name.strip().lower()
    if name.startswith("models/"):
        name = name[len("models/"):]
    if name in MODEL_TPM_LIMITS:
        return MODEL_TPM_LIMITS[name]

    best = ""
    for known in MODEL_TPM_LIMITS:
        if name.startswith(known) and len(known) > len(best):
            best = known
    return MODEL_TPM_LIMITS[best] if best else DEFAULT_TPM_LIMIT


def model_tpm_limit(model=None):
    """
    Input tokens-per-minute allowed for `model`, which this hook treats as a
    hard per-request context limit (see MODEL_TPM_LIMITS).

    `COMMIT_AI_TPM_LIMIT` overrides everything -- paid tiers have far higher
    limits, and nobody should have to edit the hook to use one.
    """
    override = (os.environ.get("COMMIT_AI_TPM_LIMIT") or "").strip()
    if override:
        try:
            value = int(override)
        except ValueError:
            value = 0
        if value > 0:
            return value

    return _listed_tpm_limit(model or AI_MODEL)


def prompt_budget(model=None):
    """
    Character budgets sized so one request cannot breach the model's
    per-minute token limit.

    Tokens are estimated from character counts rather than counted for real:
    Gemini's countTokens endpoint would mean a second network round-trip per
    commit, and it charges against the very budget being measured. A
    pessimistic chars-per-token ratio plus a safety fraction buys the same
    guarantee for free.
    """
    tpm = model_tpm_limit(model)
    usable_tokens = int(tpm * (1.0 - TPM_SAFETY_FRACTION)) - OVERHEAD_TOKENS
    total = max(0, int(usable_tokens * CHARS_PER_TOKEN))

    diff, context = DIFF_BUDGET, CONTEXT_BUDGET
    if diff + context + FIXED_SECTION_CHARS > total:
        room = max(0, total - FIXED_SECTION_CHARS)
        share = DIFF_BUDGET + CONTEXT_BUDGET
        # Shrink both proportionally: a tight budget still needs *some*
        # narrative, or the message can say what changed but never why.
        diff = max(MIN_DIFF_BUDGET, room * DIFF_BUDGET // share)
        context = max(MIN_CONTEXT_BUDGET, room * CONTEXT_BUDGET // share)

    return PromptBudget(
        total=total, diff=diff, context=context, tpm=tpm, model=model or AI_MODEL
    )


def _build_prompt(repo_root, targets, staged, transcript_path, guidance):
    """Assemble the user-content half of the request; returns (text, stats)."""
    budget = prompt_budget()
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo_root).stdout.strip()
    log_result = run(
        ["git", "log", f"-n{LOG_SAMPLE}", "--format=%s", "--no-merges"], repo_root
    )
    # One pathological subject (a whole changelog on one line) would otherwise
    # dominate the style sample it is meant to illustrate.
    log = "\n".join(
        _truncate(line, 120) for line in log_result.stdout.splitlines() if line.strip()
    )

    summary = collect_file_summary(repo_root, targets, staged)
    raw_diff = collect_diff(repo_root, targets, staged)
    diff = trim_diff(raw_diff, budget.diff)
    context = collect_session_context(transcript_path, repo_root, budget.context)

    sections = []
    if guidance:
        sections.append(
            "USER GUIDANCE (follow this; it overrides your own emphasis):\n"
            + guidance
        )
    sections.append(f"BRANCH: {branch or '(unknown)'}")
    sections.append(
        "RECENT COMMIT SUBJECTS (match this style):\n" + (log or "  (no commits yet)")
    )
    sections.append("FILES IN THIS COMMIT:\n" + (summary or "  (none reported)"))
    sections.append(
        "SESSION NARRATIVE (why the change was made):\n"
        + (context or "  (no transcript available)")
    )
    sections.append("DIFF TO BE COMMITTED:\n" + (diff or "  (empty)"))

    text = "\n\n".join(sections)

    # Last resort. The per-section budgets have floors and the fixed sections
    # (a long commit-log sample, a hundred-file summary) are estimates, so the
    # ceiling is only a guarantee if it is also enforced on the whole string.
    truncated = 0
    if budget.total and len(text) > budget.total:
        truncated = len(text) - budget.total
        marker = f"\n\n... [{truncated} chars omitted to fit the token limit] ..."
        text = text[: max(0, budget.total - len(marker))] + marker

    stats = {
        "diff_chars": len(raw_diff),
        "diff_sent": len(diff),
        "context_chars": len(context),
        "files": len([r for r in summary.splitlines() if r.strip()]),
        "prompt_chars": len(text),
        "prompt_tokens_est": estimate_tokens(text) + OVERHEAD_TOKENS,
        "tpm_limit": budget.tpm,
        "hard_truncated": truncated,
    }
    return text, stats


def estimate_tokens(text):
    """Pessimistic token count for `text` -- see CHARS_PER_TOKEN."""
    return int(len(text) / CHARS_PER_TOKEN) + 1


def _response_schema():
    """Gemini REST `responseSchema` for the generated commit message."""
    return {
        "type": "OBJECT",
        "properties": {
            # Ordered first so the model reasons about the diff before
            # committing to a subject, rather than justifying one after.
            "reasoning": {
                "type": "STRING",
                "description": (
                    "Brief: what does this diff actually change, and why? "
                    "Note the commit style used by the recent log."
                ),
            },
            "subject": {
                "type": "STRING",
                "description": "The subject line. Imperative, <=72 chars, no trailing period.",
            },
            "body": {
                "type": "STRING",
                "description": (
                    "Body explaining why, wrapped at ~72 columns. "
                    "Empty string for a small self-explanatory change."
                ),
            },
        },
        "required": ["reasoning", "subject"],
        "propertyOrdering": ["reasoning", "subject", "body"],
    }


def _gemini_error_message(exc):
    """Extract Google's useful message without leaking request credentials."""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            body = exc.read().decode("utf-8", errors="replace")
            payload = json.loads(body)
            message = payload.get("error", {}).get("message")
            if message:
                return f"HTTP {exc.code}: {message}"
        except (OSError, ValueError, AttributeError):
            pass
        return f"HTTP {exc.code}: {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return str(exc.reason)
    return str(exc)


def _gemini_response_text(response):
    """Return text from the first candidate, mirroring the SDK's `.text`."""
    candidates = response.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        return None, ""
    if not isinstance(candidates[0], dict):
        return None, ""
    candidate = candidates[0]
    content = candidate.get("content")
    parts = (content.get("parts") or []) if isinstance(content, dict) else []
    text = "".join(
        part.get("text", "")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )
    return text or None, candidate.get("finishReason") or ""


def generate_commit_message(repo_root, targets, staged, transcript_path, guidance):
    """
    One Gemini call. Raises AiError with something the user can act on;
    the caller must not fall back to a placeholder message.
    """
    api_key, _ = find_api_key(repo_root)
    if not api_key:
        raise AiError(key_setup_help(repo_root))

    # Refuse before building the prompt: Google will reject this call in a
    # second anyway, with a far less helpful message. COMMIT_AI_TPM_LIMIT
    # skipped on purpose -- with a paid key the listed quota is 0 anyway, so
    # the override is also how the prompt gets sized correctly. The map
    # lookup itself respects suffix matches, so "gemini-2.5-pro-exp" is
    # refused like "gemini-2.5-pro".
    free_models = sorted(m for m, tpm in MODEL_TPM_LIMITS.items() if tpm > 0)
    if _listed_tpm_limit(AI_MODEL) <= 0:
        raise AiError(
            f"'{AI_MODEL}' has no Google free-tier quota (0 requests per day) "
            f"-- only a paid-tier API key can use it.\n"
            f"Switch to a free-tier model, e.g.:\n"
            f"    setx COMMIT_AI_MODEL \"{AI_MODEL_DEFAULT}\"   (Windows, new shells only)\n"
            f"    export COMMIT_AI_MODEL={AI_MODEL_DEFAULT}     (bash/zsh)\n"
            f"All free-tier models: {', '.join(free_models)}\n"
            f"(On a paid key, also set COMMIT_AI_TPM_LIMIT to your tier's "
            f"limit so the prompt is sized for it.)"
        )

    prompt, stats = _build_prompt(
        repo_root, targets, staged, transcript_path, guidance
    )

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _response_schema(),
            "temperature": 0.3,
        },
    }
    model = urllib.parse.quote(AI_MODEL, safe="")
    request = urllib.request.Request(
        f"{GEMINI_BASE_URL}/v1beta/models/{model}:generateContent",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as raw:
            response = json.loads(raw.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AiError(
            f"Gemini call failed ({AI_MODEL}): {_gemini_error_message(exc)}"
        )
    except ValueError as exc:
        raise AiError(f"Gemini returned an invalid response ({AI_MODEL}): {exc}")

    if not isinstance(response, dict):
        raise AiError(f"Gemini returned an invalid response ({AI_MODEL}).")

    text, finish_reason = _gemini_response_text(response)
    if not text:
        reason = f" (finish_reason={finish_reason})" if finish_reason else ""
        raise AiError(f"Gemini returned no message{reason}.")

    try:
        parsed = json.loads(text)
    except ValueError:
        raise AiError(f"Gemini returned unparseable output:\n{text[:400]}")
    if not isinstance(parsed, dict):
        raise AiError(f"Gemini returned an unexpected JSON value:\n{text[:400]}")

    subject_value = parsed.get("subject")
    subject = _clean_line(subject_value) if isinstance(subject_value, str) else ""
    if not subject:
        raise AiError("Gemini returned an empty subject line.")

    body = parsed.get("body") or ""
    reasoning = parsed.get("reasoning") or ""
    if not isinstance(body, str) or not isinstance(reasoning, str):
        raise AiError("Gemini returned invalid commit message fields.")

    return AiMessage(
        subject=subject,
        body=body.strip(),
        reasoning=reasoning.strip(),
        model=AI_MODEL,
        source=stats,
    )


def _clean_line(subject):
    """Belt-and-braces against fences/quotes slipping through the schema."""
    subject = subject.strip().strip("`").strip()
    subject = re.sub(r"^(?:subject|commit message)\s*:\s*", "", subject, flags=re.I)
    if len(subject) > 1 and subject[0] == subject[-1] and subject[0] in "\"'":
        subject = subject[1:-1].strip()
    return subject.splitlines()[0].strip() if subject else ""


def build_dry_run_report(message, session_id, transcript_path, repo_root, scan, flags):
    """
    Describe exactly what a real `/commit` would do, running every
    read-only step for real (transcript parse, out-of-repo filter,
    `git ls-files`, `git status`) and stopping before `add`/`commit`.

    With --ai the message is generated for real, so it can be copied,
    edited, and replayed as `/commit <message>` -- but only if there is
    genuinely something to commit.
    """
    out = ["Dry run -- nothing was staged or committed.", ""]
    if message and not flags.use_ai:
        out.append(f"Message: {message}")
        out.append("")

    # targets stays empty in the fall-back branches, which is exactly the
    # pathspec scope a real run would use there: none, i.e. the whole repo.
    targets = []
    fallback = False

    if scan is None:
        out.append("Would stage all uncommitted changes in the repo:")
        out.append("")
        status = run(["git", "status", "--porcelain"], repo_root)
        out.append(status.stdout.rstrip() or "  (working tree is clean)")
        fallback = True
    else:
        # Surface the discards. These are the filters that otherwise make the
        # hook look like it has silently lost a file.
        if scan.failed_paths:
            out.append("")
            out.append(f"Skipped -- tool call failed ({len(scan.failed_paths)}):")
            out += [f"  {_rel(p, repo_root)}" for p in scan.failed_paths]
        if scan.outside:
            out.append("")
            out.append(f"Skipped -- outside this repo ({len(scan.outside)}):")
            out += [f"  {p}" for p in scan.outside]
        if scan.ignored:
            out.append("")
            out.append(f"Skipped -- gitignored ({len(scan.ignored)}):")
            out += [f"  {_rel(p, repo_root)}" for p in scan.ignored]
        if scan.unresolved:
            out.append("")
            out.append(
                f"Shell writes whose target could not be read ({len(scan.unresolved)}):"
            )
            out += [f"  {_shorten(c)}" for c in scan.unresolved]
            out.append("  Staging everything rather than commit a subset.")

        if changed_paths(scan) is None:
            out.append("")
            out.append("Would stage all uncommitted changes in the repo.")
            fallback = True
        else:
            present, deletions, unmatched = resolve_stage_set(scan.paths, repo_root)

            if unmatched:
                out.append("")
                out.append(
                    f"Skipped -- no longer exist ({len(unmatched)}):"
                )
                out += [f"  {_rel(p, repo_root)}" for p in unmatched]

            targets = present + deletions
            out.append("")
            out.append(f"Would stage ({len(targets)}):")
            for p in present:
                out.append(f"  {_rel(p, repo_root)}")
            for p in deletions:
                out.append(f"  {_rel(p, repo_root)}  [deletion]")

    # Anything already in the index that isn't ours. The commit is
    # pathspec-scoped precisely so these are left alone -- an unscoped
    # `git commit` would sweep every one of them into the commit.
    merging = in_merge(repo_root)
    others = staged_elsewhere(targets, repo_root) if targets else []
    if others:
        out.append("")
        if merging:
            out.append(f"Already staged ({len(others)}) -- WILL BE COMMITTED:")
            out += [f"  {p}" for p in others]
            out.append("  (mid-merge: git requires committing all staged changes)")
        else:
            out.append(f"Already staged ({len(others)}) -- would be left alone:")
            out += [f"  {p}" for p in others]

    # Whether those paths actually differ from HEAD is the other half of
    # the answer; edited-then-reverted files stage to nothing.
    status_args = ["git", "status", "--porcelain"]
    if targets:
        status_args += ["--", *targets]
    # Keep the leading column: ' M' (unstaged) vs 'M ' (staged) is precisely
    # the distinction this report exists to show, and strip() eats it.
    pending_raw = run(status_args, repo_root).stdout
    pending = pending_raw.strip()

    if targets:
        out.append("")
        if pending:
            out.append("Changes to commit:")
            out.append(pending_raw.rstrip("\n"))
        else:
            out.append("No changes to commit -- files match HEAD.")
            out.append("A real /commit would exit with 'nothing to commit'.")

    if not flags.use_ai:
        return "\n".join(out)
    out.append("")
    out.append("=" * 68)

    if not pending:
        out.append("No changes to commit -- --ai not called.")
        return "\n".join(out)

    try:
        ai = generate_commit_message(repo_root, targets, False, transcript_path, message)
    except AiError as exc:
        out.append("Failed to generate commit message:")
        out.append("")
        out.append(str(exc))
        return "\n".join(out)

    stats = ai.source
    out.append("")
    out.append(
        f"Prompt sent to {ai.model}: ~{stats['prompt_tokens_est']} tokens "
        f"(limit {stats['tpm_limit']}/min), {stats['diff_sent']} of "
        f"{stats['diff_chars']} diff chars"
        + (", hard-truncated" if stats["hard_truncated"] else "")
    )

    if ai.reasoning:
        out.append("")
        out.append("Generated reasoning: " + _truncate(ai.reasoning, 500))
    out.append("")
    out.append("Generated commit message:")
    out.append("-" * 68)
    out.append(ai.subject)
    if ai.body:
        out.append("")
        out.append(ai.body)
    out.append("-" * 68)
    out.append("")
    out.append("To use this message: /commit <copy message above>")
    return "\n".join(out)


def cli_main(argv):
    """
    Debug entry point, bypassing the hook protocol entirely:

        python commit_UserPromptSubmit_hook.py --transcript <path> [--cwd <dir>] [--ai]

    Always a dry run, so it can be pointed at any historical transcript
    without touching a repo. Prints to stdout and exits 0.
    """
    args = {"--transcript": "", "--cwd": os.getcwd(), "--message": ""}
    use_ai = False
    key = None
    for token in argv:
        if token in args:
            key = token
        elif token in DRY_FLAGS:
            continue
        elif token in AI_FLAGS:
            use_ai = True
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

    message = args["--message"] or ("" if use_ai else "(dry run)")
    scan = _scan_writes(args["--transcript"], repo_root)
    print(
        build_dry_run_report(
            message, "(cli)", args["--transcript"], repo_root, scan,
            Flags(dry=True, use_ai=use_ai),
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

    flags, message = split_flags(match.group(1) or "")
    if not message and not flags.use_ai and not flags.dry:
        finish(
            "Usage: /commit [--dry] [--ai] <message>\n"
            "  --ai      generate the message from the staged diff "
            "(makes <message> optional)\n"
            "            any text after --ai becomes steering guidance\n"
            "  --dry show what would happen, change nothing"
        )
        return

    toplevel = run(["git", "rev-parse", "--show-toplevel"], cwd)
    if toplevel.returncode != 0:
        finish("Not a git repository -- nothing to commit.")
        return
    repo_root = os.path.normpath(toplevel.stdout.strip()) or cwd

    if flags.dry:
        scan = _scan_writes(transcript_path, repo_root)
        finish(
            build_dry_run_report(
                message, session_id, transcript_path, repo_root, scan, flags
            )
        )
        return

    scan = _scan_writes(transcript_path, repo_root)
    changed = changed_paths(scan)
    widened = ""

    if changed:
        add_result, targets = stage_paths(changed, repo_root)
        if add_result is None:
            finish(
                "Claude edited files this session, but none of them still "
                "exist or are tracked -- nothing to stage."
            )
            return
    else:
        # No usable session-derived list -- an unreadable transcript, or a
        # shell write whose target the scan could not name. Stage everything
        # rather than commit a subset, and say which it was.
        add_result, targets = run(["git", "add", "-A"], repo_root), []
        if scan is not None and scan.unresolved:
            widened = (
                f"; staged the whole tree -- {len(scan.unresolved)} shell "
                "write(s) with an unreadable target"
            )

    if add_result.returncode != 0:
        finish(f"git add failed:\n{add_result.stderr}")
        return

    # Scope every remaining step to our own paths. Both `git diff --cached`
    # and `git commit` default to the WHOLE INDEX, which may already hold
    # files the user staged by hand before /commit ran -- staging selectively
    # is pointless if the commit then sweeps them all up anyway.
    # Mid-merge is the exception: git forbids partial commits there.
    scope = ["--", *targets] if targets and not in_merge(repo_root) else []

    staged = run(["git", "diff", "--cached", "--name-only", *scope], repo_root)
    if not staged.stdout.strip():
        finish("Nothing to commit -- working tree matches HEAD.")
        return

    # Only now, with something definitely to commit, is it worth an API call.
    body = ""
    if flags.use_ai:
        try:
            ai = generate_commit_message(
                repo_root, targets if scope else [], True, transcript_path, message
            )
        except AiError as exc:
            finish(
                f"{exc}\n\n"
                f"{len(staged.stdout.strip().splitlines())} file(s) are still staged -- "
                "nothing was committed.\nRerun with an explicit message: /commit <message>"
            )
            return
        message, body = ai.subject, ai.body

    commit_args = ["git", "commit", "-m", message]
    if body:
        commit_args += ["-m", body]
    commit_args += ["-m", f"Claude-session: {session_id}", *scope]
    commit_result = run(commit_args, repo_root)

    if commit_result.returncode != 0:
        finish(f"git commit failed:\n{commit_result.stderr}")
        return

    sha = run(["git", "rev-parse", "--short", "HEAD"], repo_root).stdout.strip()
    count = len(staged.stdout.strip().splitlines())
    held_back = len(staged_elsewhere(targets, repo_root)) if scope else 0
    suffix = f", {held_back} left staged" if held_back else ""
    finish(f"Committed {sha} ({count} file(s){suffix}){widened}: {message}")


if __name__ == "__main__":
    main()
