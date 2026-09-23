"""Load user-invocable skills that Claude Code leaves unexpanded later in a prompt."""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
import tempfile
from pathlib import Path


INVOCATION = re.compile(r"(?<!\S)/([A-Za-z0-9][\w.:-]*)(?=\s|$)")
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,}).*?(?:^[ \t]*\1[ \t]*$|\Z)", re.MULTILINE | re.DOTALL)
MANAGED_ROOTS: tuple[Path, ...] = tuple(Path(root) for root in {
    "win32": [r"C:\Program Files\ClaudeCode"],
    "darwin": ["/Library/Application Support/ClaudeCode"],
}.get(sys.platform, ["/etc/claude-code"]))


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def project_dirs(cwd: Path) -> list[Path]:
    """The working directory and its parents up to the repository root."""
    chain = [cwd, *cwd.parents]
    for index, directory in enumerate(chain):
        if (directory / ".git").exists():
            return chain[: index + 1]
    return [cwd]


def configuration_roots(cwd: Path) -> list[Path]:
    """Claude Code's precedence: managed over personal over project."""
    return [*(root / ".claude" for root in MANAGED_ROOTS), config_dir(), *(d / ".claude" for d in project_dirs(cwd))]


def find_skill(name: str, cwd: Path) -> Path | None:
    """A skill directory wins over a command file of the same name at any location."""
    if any(part in {"", ".", ".."} for part in name.split(":")):
        return None
    roots = configuration_roots(cwd)
    if ":" not in name:
        for root in roots:
            candidate = root / "skills" / name / "SKILL.md"
            if candidate.is_file():
                return candidate
    for root in roots:
        candidate = root.joinpath("commands", *name.split(":")).with_suffix(".md")
        if candidate.is_file():
            return candidate
    return None


def skill_overrides(project: Path) -> dict:
    overrides: dict = {}
    sources = [
        config_dir() / "settings.json", project / ".claude" / "settings.json", project / ".claude" / "settings.local.json",
        *(root / "managed-settings.json" for root in MANAGED_ROOTS),
    ]
    for source in sources:
        try:
            settings = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(settings, dict) and isinstance(settings.get("skillOverrides"), dict):
            overrides.update(settings["skillOverrides"])
    return overrides


def runs_inline(fields: dict) -> bool:
    """Whether typing the skill's name would load it into the current context."""
    invocable = str(fields.get("user-invocable", "true")).lower() not in {"false", "no", "off", "0"}
    return invocable and fields.get("context") != "fork"


def split_frontmatter(text: str) -> tuple[dict, str]:
    """Top-level scalar and list fields only; that is all the rendering needs."""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != "---":
        return {}, text
    closing = next((index for index, line in enumerate(lines[1:], 1) if line.rstrip() == "---"), None)
    if closing is None:
        return {}, text
    fields: dict = {}
    key = None
    for line in lines[1:closing]:
        item = re.match(r"^\s+-\s*(.*?)\s*$", line)
        if item and key is not None and isinstance(fields.get(key), list):
            fields[key].append(item.group(1).strip("'\""))
            continue
        pair = re.match(r"^([A-Za-z][\w-]*):\s*(.*?)\s*$", line)
        if not pair:
            continue
        key, value = pair.groups()
        if value.startswith("[") and value.endswith("]"):
            fields[key] = [part.strip().strip("'\"") for part in value[1:-1].split(",") if part.strip()]
        else:
            fields[key] = value.strip("'\"") if value else []
    return fields, "".join(lines[closing + 1:])


def argument_names(fields: dict) -> list[str]:
    names = fields.get("arguments", [])
    return names.split() if isinstance(names, str) else names


def substitute(body: str, args: str, names: list[str]) -> tuple[str, bool]:
    """Expand argument placeholders in one pass so inserted values are never expanded again."""
    try:
        words = shlex.split(args)
    except ValueError:
        words = args.split()
    named = "|".join(map(re.escape, sorted(names, key=len, reverse=True)))
    pattern = re.compile(rf"(\\*)\$(?:ARGUMENTS\[(\d+)\]|(ARGUMENTS)|(\d+)" + (rf"|(?P<name>{named})(?!\w)" if named else "") + ")")
    received = False

    def replace(match: re.Match) -> str:
        nonlocal received
        slashes, index, whole, digit = match.group(1, 2, 3, 4)
        name = match.groupdict().get("name")
        if len(slashes) == 1:
            return match.group(0)[1:]
        if whole:
            value = args
        elif name:
            position = names.index(name)
            value = words[position] if position < len(words) else ""
        else:
            position = int(index or digit)
            if position >= len(words):
                return match.group(0)
            value = words[position]
        received = True
        return slashes + value

    return pattern.sub(replace, body), received


def render(name: str, path: Path, args: str, session: str, project: Path, overrides: dict) -> str | None:
    """The skill's content in the shape Claude Code gives the model, or None when typing it would not load it."""
    fields, body = split_frontmatter(path.read_text(encoding="utf-8"))
    if not runs_inline(fields) or overrides.get(name) == "off":
        return None
    body, received = substitute(body, args, argument_names(fields))
    for variable, value in (
        ("CLAUDE_SKILL_DIR", path.parent.as_posix()), ("CLAUDE_SESSION_ID", session), ("CLAUDE_PROJECT_DIR", str(project)),
    ):
        body = body.replace("${" + variable + "}", value)
    if args and not received:
        body = f"{body.rstrip()}\n\nARGUMENTS: {args}"
    base = f"Base directory for this skill: {path.parent}\n\n" if path.name == "SKILL.md" else ""
    return (
        f"<command-message>{name}</command-message>\n<command-name>/{name}</command-name>\n"
        f"<command-args>{args}</command-args>\n\n{base}{body.strip()}"
    )


def expansions_file(session: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session)
    return Path(tempfile.gettempdir()) / f"harness_mid_prompt_skills_{safe}.jsonl"


def record_expansion(payload: dict) -> None:
    """Claude Code fires this before UserPromptSubmit for every skill it expands itself."""
    name, prompt = payload.get("command_name"), payload.get("prompt")
    if isinstance(name, str) and isinstance(prompt, str):
        with expansions_file(payload["session_id"]).open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"prompt": prompt, "name": name}) + "\n")


def take_expansions(session: str, prompt: str) -> list[str]:
    path = expansions_file(session)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        path.unlink()
    except OSError:
        return []
    names = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and record.get("prompt") == prompt and isinstance(record.get("name"), str):
            names.append(record["name"])
    return names


def handle(payload: dict) -> dict | None:
    event, session = payload.get("hook_event_name"), payload.get("session_id")
    if not isinstance(session, str) or not session:
        return None
    if event == "UserPromptExpansion":
        record_expansion(payload)
        return None
    prompt = payload.get("prompt")
    if event != "UserPromptSubmit" or not isinstance(prompt, str):
        return None
    expanded = take_expansions(session, prompt)
    cwd = Path(payload.get("cwd") or os.getcwd())
    project = Path(os.environ.get("CLAUDE_PROJECT_DIR") or cwd)
    fences = [fence.span() for fence in FENCE.finditer(prompt)]
    found = [
        (match, find_skill(match.group(1), cwd)) for match in INVOCATION.finditer(prompt)
        if not any(start <= match.start() < end for start, end in fences)
    ]
    found = [(match, path) for match, path in found if path is not None]
    overrides = skill_overrides(project) if found else {}
    blocks = []
    for index, (match, path) in enumerate(found):
        name = match.group(1)
        if name in expanded:
            expanded.remove(name)
            continue
        # Arguments run to the next skill or the end of the line, so a skill cannot absorb the following lines.
        end = found[index + 1][0].start() if index + 1 < len(found) else len(prompt)
        line_end = prompt.find("\n", match.end())
        if line_end != -1:
            end = min(end, line_end)
        block = render(name, path, prompt[match.end():end].strip(), session, project, overrides)
        if block is not None:
            blocks.append(block)
    if not blocks:
        return None
    header = (
        "The user's prompt invokes these skills after other text, where Claude Code does not expand them. "
        "Their instructions follow as Claude Code loads them."
    )
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n\n".join([header, *blocks])}}


def main() -> int:
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(handle(json.load(sys.stdin)) or {}))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
