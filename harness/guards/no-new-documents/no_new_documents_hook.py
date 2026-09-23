#!/usr/bin/env python3
"""Route new documents in configured paths through user-approved drafts.

PreToolUse denies creating a file in a protected path and points the agent at
the mirrored draft path under `.harness/doc-drafts/`. UserPromptSubmit handles
`approve-doc-draft` and `reject-doc-draft` without a model turn, then tells
the agent the outcome on its next prompt.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


CONFIG_NAME = "no-new-documents.toml"
DRAFTS_DIR = Path(".harness/doc-drafts")

CLAUDE = "claude"
CHATGPT = "chatgpt"
COMMAND_PREFIX = {CLAUDE: "/", CHATGPT: "$"}

# Set by `main` from argv, before anything reads it.
PROVIDER = CLAUDE


def _config_sources(root: Path) -> list[Path]:
    candidates = [
        Path(__file__).with_name(CONFIG_NAME),
        Path.home() / ".harness" / "guards" / CONFIG_NAME,
        root / ".harness" / "guards" / CONFIG_NAME,
    ]
    sources: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        key = candidate.resolve()
        if key not in seen and candidate.is_file():
            seen.add(key)
            sources.append(candidate)
    return sources


ADD_FILE = re.compile(r"^\*\*\* Add File: (.+)$", re.MULTILINE)
REDIRECTION = re.compile(
    r"(?:^|\s)(?:\d?>{1,2})\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))"
)
POWERSHELL_NEW_FILE = re.compile(
    r"\bNew-Item\b(?=[^;&|]*-ItemType\s+File\b)[^;&|]*"
    r"-(?:LiteralPath|Path)\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
BASH_TOUCH = re.compile(
    r"(?:^|[;&|]\s*)touch\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))\s*(?:$|[;&|])"
)
POWERSHELL_CONTENT = re.compile(
    r"\b(?:Set-Content|Add-Content)\b[^;&|]*?-(?:LiteralPath|Path)\s+"
    r"(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
POWERSHELL_OUT_FILE = re.compile(
    r"\bOut-File\b[^;&|]*?-FilePath\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
MOVE_OR_COPY = re.compile(
    r"(?:^|[;&|]\s*)(?:mv|cp|move|copy|Move-Item|Copy-Item)\s+([^;&|]+)", re.IGNORECASE
)
SHELL_TOKEN = re.compile(r"\"([^\"]*)\"|'([^']*)'|(\S+)")
DRAFT_COMMAND = re.compile(r"(?<!\S)[$@/](approve|reject)-doc-draft(?=\s|$)(.*)$", re.DOTALL)
CWD_CHANGE = re.compile(r"(?:^|[;&|]\s*)(?:cd|chdir|Set-Location|Push-Location)\b", re.IGNORECASE)


def _configuration(root: Path) -> tuple[re.Pattern[str], ...]:
    compiled: list[re.Pattern[str]] = []
    sources = _config_sources(root)
    if not sources:
        raise ValueError("no-new-documents configuration is missing")
    for source in sources:
        data = tomllib.loads(source.read_text(encoding="utf-8"))
        raw_patterns = data.get("protected")
        if data.get("version") != 1 or set(data) != {"version", "protected"}:
            raise ValueError("invalid no-new-documents configuration")
        if not isinstance(raw_patterns, list) or not raw_patterns:
            raise ValueError("protected must be a non-empty array")
        source_patterns = tuple(_compile_pattern(item) for item in raw_patterns if isinstance(item, str))
        if len(source_patterns) != len(raw_patterns) or any(item is None for item in source_patterns):
            raise ValueError("invalid protected pattern")
        compiled.extend(item for item in source_patterns if item is not None)
    return tuple(compiled)


def _root(payload: dict[str, Any]) -> Path:
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if project:
        return Path(project).resolve()
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return Path(cwd).resolve()
    return Path.cwd().resolve()


def _relative_parts(path_text: str, root: Path) -> tuple[str, ...] | None:
    candidate = Path(path_text)
    try:
        resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
        relative = resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return tuple(relative.parts)


def _compile_pattern(pattern: str) -> re.Pattern[str] | None:
    pattern = pattern.strip().replace("\\", "/")
    if not pattern or pattern.startswith("/") or ".." in pattern.split("/"):
        return None
    anchored = "/" in pattern and not pattern.startswith("**/")
    directory = pattern.endswith("/")
    pattern = pattern.rstrip("/") if directory else pattern
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern[i:i + 2] == "**":
            if i + 2 < len(pattern) and pattern[i + 2] == "/":
                out.append("(?:[^/]+/)*")
                i += 3
            else:
                out.append(".*")
                i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    body = "".join(out) + ("(?:/.*)?" if directory else "")
    return re.compile(("^" if anchored else "^(?:[^/]+/)*") + body + "$")


def _is_protected(parts: tuple[str, ...], patterns: tuple[re.Pattern[str], ...]) -> bool:
    path = "/".join(parts)
    return any(pattern.match(path) for pattern in patterns)


def _literal_path(groups: tuple[str | None, ...]) -> str | None:
    value = next((item for item in groups if item), None)
    if value is None or any(marker in value for marker in ("$", "%", "*", "?", "`")):
        return None
    return value


def _move_or_copy_targets(arguments: str, root: Path) -> list[str]:
    """Where a literal `mv`/`cp`/`Move-Item`/`Copy-Item` would put its files."""
    sources: list[str] = []
    positional: list[str] = []
    destination: str | None = None
    tokens = [match.groups() for match in SHELL_TOKEN.finditer(arguments)]
    index = 0
    while index < len(tokens):
        quoted = tokens[index][0] is not None or tokens[index][1] is not None
        value = _literal_path(tokens[index])
        if value is None:
            return []
        flag = value.lower() if not quoted and value.startswith("-") else None
        if flag in {"-destination", "-path", "-literalpath"} and index + 1 < len(tokens):
            named = _literal_path(tokens[index + 1])
            if named is None:
                return []
            if flag == "-destination":
                destination = named
            else:
                sources.append(named)
            index += 2
            continue
        if flag is None:
            positional.append(value)
        index += 1
    if destination is None:
        if len(positional) < 2:
            return []
        destination = positional.pop()
    sources.extend(positional)
    target = Path(destination) if Path(destination).is_absolute() else root / destination
    if destination.endswith(("/", "\\")) or target.is_dir():
        return [str(target / Path(source).name) for source in sources]
    return [destination]


def _shell_candidates(command: str, root: Path) -> list[str]:
    """Return only output paths whose creation intent is syntactically clear.

    Commands that change directory or use variables/globs are deliberately
    ignored: missing a clever creation is preferable to blocking an unrelated
    command based on a guessed path.
    """
    if CWD_CHANGE.search(command):
        return []
    candidates = [
        path
        for match in REDIRECTION.finditer(command)
        if (path := _literal_path(match.groups())) is not None
    ]
    for pattern in (BASH_TOUCH, POWERSHELL_NEW_FILE, POWERSHELL_CONTENT, POWERSHELL_OUT_FILE):
        candidates.extend(
            path
            for match in pattern.finditer(command)
            if (path := _literal_path(match.groups())) is not None
        )
    for match in MOVE_OR_COPY.finditer(command):
        candidates.extend(_move_or_copy_targets(match.group(1), root))
    return candidates


def _prepare_drafts(root: Path) -> None:
    drafts = root / DRAFTS_DIR
    drafts.mkdir(parents=True, exist_ok=True)
    ignore = drafts / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8", newline="\n")


def _deny(path: str, root: Path) -> None:
    draft = f"{DRAFTS_DIR.as_posix()}/{path}"
    try:
        _prepare_drafts(root)
    except OSError:
        pass
    existing = (
        "A draft already exists there; update it instead of starting over. "
        if (root / draft).exists()
        else ""
    )
    prefix = COMMAND_PREFIX[PROVIDER]
    reason = (
        f"Creating the new document `{path}` requires the user's approval. Write it as a "
        f"draft at `{draft}` instead. {existing}Never move or copy the draft into place "
        "yourself, and do not create the document at another path. Continue any other work. "
        "In your final response, tell the user the draft is ready and why you want to add "
        f"it. They approve it with `{prefix}approve-doc-draft {path}`, discard it with "
        f"`{prefix}reject-doc-draft {path}`, or reply with feedback for you to apply to "
        "the draft."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def guard_tool(payload: dict[str, Any]) -> int:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    tool_name = payload.get("tool_name")
    root = _root(payload)
    candidates: list[str] = []
    if tool_name == "Write":
        file_path = tool_input.get("file_path")
        if isinstance(file_path, str) and file_path:
            candidates.append(file_path)
    elif tool_name == "apply_patch":
        command = tool_input.get("command") or tool_input.get("patch")
        if isinstance(command, str):
            candidates.extend(match.group(1).strip() for match in ADD_FILE.finditer(command))
    elif tool_name in {"Bash", "PowerShell"}:
        command = tool_input.get("command")
        if isinstance(command, str):
            candidates.extend(_shell_candidates(command, root))
    if not candidates:
        return 0
    try:
        patterns = _configuration(root)
    except (OSError, UnicodeError, tomllib.TOMLDecodeError, ValueError):
        return 0
    for file_path in candidates:
        parts = _relative_parts(file_path, root)
        if parts is None or parts[:len(DRAFTS_DIR.parts)] == DRAFTS_DIR.parts:
            continue
        candidate = Path(file_path) if Path(file_path).is_absolute() else root / file_path
        if not candidate.exists() and _is_protected(parts, patterns):
            _deny("/".join(parts), root)
            break
    return 0


# The user's draft commands, handled here so they never cost a model turn

def _block_prompt(message: str) -> int:
    if PROVIDER == CHATGPT:
        print(json.dumps({"decision": "block", "reason": message}))
        return 0
    sys.stderr.write(f"\n\n{message}")
    return 2


def _draft_files(root: Path, argument: str) -> list[str]:
    """Draft target paths named by `argument`, a file or a directory of drafts."""
    drafts = root / DRAFTS_DIR
    argument = argument.strip().strip("\"'").replace("\\", "/")
    prefix = DRAFTS_DIR.as_posix() + "/"
    if argument.startswith(prefix):
        argument = argument[len(prefix):]
    parts = _relative_parts(argument, drafts)
    if not parts:
        return []
    selected = drafts.joinpath(*parts)
    if selected.is_file():
        return ["/".join(parts)]
    return _drafts_below(selected, drafts)


def _drafts_below(directory: Path, drafts: Path) -> list[str]:
    if not directory.is_dir():
        return []
    return sorted(
        path.relative_to(drafts).as_posix()
        for path in directory.rglob("*")
        if path.is_file() and path != drafts / ".gitignore"
    )


def _listing(root: Path, command: str) -> str:
    pending = _drafts_below(root / DRAFTS_DIR, root / DRAFTS_DIR)
    if not pending:
        return "No document drafts are pending."
    lines = [f"Pending document drafts (pass a path or directory to {command}):"]
    for target in pending:
        note = "  (a file already exists there)" if (root / target).exists() else ""
        lines.append(f"  {target}{note}")
    return "\n".join(lines)


def _prune_empty(directory: Path, stop: Path) -> None:
    while directory != stop and directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()
        directory = directory.parent


def _approve(root: Path, target: str) -> bool:
    draft = root / DRAFTS_DIR / target
    destination = root / target
    if destination.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    draft.rename(destination)
    _prune_empty(draft.parent, root / DRAFTS_DIR)
    return True


def _reject(root: Path, target: str) -> bool:
    draft = root / DRAFTS_DIR / target
    draft.unlink()
    _prune_empty(draft.parent, root / DRAFTS_DIR)
    return True


# A blocked prompt is erased from the agent's context, so each outcome waits
# outside the repository and rides along with that session's next prompt.

def _notice_path(root: Path, session_id: str) -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    state = Path(configured).expanduser() if configured else Path.home() / ".harness"
    key = hashlib.sha256(f"{root}\0{session_id}".encode("utf-8")).hexdigest()[:24]
    return state / "doc-drafts" / f"{key}.json"


def _record_outcomes(path: Path, outcomes: dict[str, list[str]]) -> None:
    try:
        pending = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pending = {}
    for verb, targets in outcomes.items():
        pending[verb] = [*pending.get(verb, []), *targets]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(pending), encoding="utf-8")


def _flush_notice(path: Path) -> str | None:
    try:
        pending = json.loads(path.read_text(encoding="utf-8"))
        path.unlink()
    except (OSError, ValueError):
        return None
    lines = []
    if pending.get("approved"):
        lines.append(
            "Since your last turn, the user approved these document drafts. They now exist "
            "at their final paths and the drafts are gone; edit them there: "
            + ", ".join(f"`{target}`" for target in pending["approved"])
        )
    if pending.get("rejected"):
        lines.append(
            "Since your last turn, the user rejected and deleted these document drafts; do "
            "not recreate them unless asked: "
            + ", ".join(f"`{target}`" for target in pending["rejected"])
        )
    return "\n".join(lines) or None


def handle_prompt(payload: dict[str, Any]) -> int:
    text = payload.get("prompt")
    match = DRAFT_COMMAND.search(text) if isinstance(text, str) else None
    root = _root(payload)
    notices = _notice_path(root, str(payload.get("session_id") or "unknown"))
    if match is None:
        try:
            notice = _flush_notice(notices)
        except Exception:  # noqa: BLE001 - a damaged notice never blocks a prompt
            notice = None
        if notice:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": notice,
                }
            }))
        return 0
    arguments = match.group(2).split()
    if not arguments:
        return _block_prompt(_listing(root, f"{match.group(1)}-doc-draft"))
    approve = match.group(1) == "approve"
    done: list[str] = []
    lines = []
    for argument in arguments:
        targets = _draft_files(root, argument)
        if not targets:
            lines.append(f"No draft found for `{argument}`.")
        for target in targets:
            try:
                changed = (_approve if approve else _reject)(root, target)
            except OSError as error:
                lines.append(f"Could not {match.group(1)} `{target}`: {error}")
                continue
            if not changed:
                lines.append(f"Kept the draft of `{target}`: a file already exists there.")
                continue
            done.append(target)
            lines.append(f"Approved `{target}`." if approve else f"Discarded the draft of `{target}`.")
    if done:
        try:
            _record_outcomes(notices, {"approved" if approve else "rejected": done})
        except OSError:
            lines.append("The agent could not be told about this; mention it in your next message.")
    return _block_prompt("\n".join(lines))


def main() -> int:
    global PROVIDER
    PROVIDER = CHATGPT if "--" + CHATGPT in sys.argv[1:] else CLAUDE
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    if payload.get("hook_event_name") == "UserPromptSubmit":
        return handle_prompt(payload)
    return guard_tool(payload)


if __name__ == "__main__":
    raise SystemExit(main())
