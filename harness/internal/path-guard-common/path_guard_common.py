"""Shared, deliberately bounded shell coverage and observed-read evidence.

Shell parsing is supplemental: arbitrary scripts are not a filesystem sandbox.
Only simple, complete reads with matching successful output grant read evidence.
"""
from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path
import re
import shlex
import tempfile
import uuid


def relative(path: str, root: Path) -> str | None:
    if not isinstance(path, str) or not path:
        return None
    try:
        return (root / path).resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def tokens(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    lexer.escape = ""  # Preserve Windows paths; do not interpret shell code.
    try:
        return list(lexer)
    except ValueError:
        return []


def shell_paths(command: str, root: Path, *, writing: bool = False, depth: int = 0, cwd: Path | None = None) -> list[str]:
    """Common shell operations, quoted paths, redirects and sequential cwd changes."""
    if depth > 3 or not isinstance(command, str):
        return []
    words = tokens(command.replace("\r\n", "\n").replace("\n", ";"))
    cwd, found, segment = cwd or root, [], []

    def add(value: str) -> None:
        if not value or value.startswith("-") or any(c in value for c in "$`\n"):
            return
        candidate = cwd / value
        expanded = glob.glob(str(candidate), recursive=True) if any(c in value for c in "*?[") else [str(candidate)]
        for item in expanded:
            path = relative(item, root)
            if path is not None and path not in found:
                found.append(path)

    def visit(part: list[str]) -> None:
        nonlocal cwd
        if not part:
            return
        verb = part[0].replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".exe")
        args = part[1:]
        if verb in {"bash", "sh", "pwsh", "powershell"}:
            for index, arg in enumerate(args[:-1]):
                if arg.lower() in {"-c", "-command"}:
                    found.extend(path for path in shell_paths(args[index + 1], root, writing=writing, depth=depth + 1, cwd=cwd) if path not in found)
                    return
        if verb in {"cd", "set-location", "pushd"}:
            paths = [arg for arg in args if not arg.startswith("-")]
            if paths:
                cwd = (cwd / paths[-1]).resolve()
            return
        clean = []
        skip = False
        for index, arg in enumerate(args):
            if skip:
                skip = False
                continue
            if re.fullmatch(r"[<>]+", arg):
                if index + 1 < len(args):
                    if writing and ">" in arg and args[index + 1] != "&":
                        add(args[index + 1])
                    skip = True
                continue
            clean.append(arg)
        if not writing:
            if verb in {"cat", "more", "less", "head", "tail", "type", "get-content", "gc"}:
                skip_value = False
                for arg in clean:
                    if skip_value:
                        skip_value = False
                        continue
                    if arg.lower() in {"-n", "-c", "--lines", "--bytes", "-totalcount", "-tail", "-encoding"}:
                        skip_value = True
                        continue
                    add(arg)
            elif verb == "sed" and not any(arg.startswith("-i") for arg in clean):
                for arg in clean[1:]:
                    add(arg)
            return
        if verb in {"tee", "touch", "truncate", "rm", "remove-item", "clear-content"}:
            for arg in clean:
                add(arg)
        elif verb in {"cp", "mv", "copy", "move", "copy-item", "move-item", "install"}:
            positional = [arg for arg in clean if not arg.startswith("-")]
            if len(positional) >= 2:
                sources, destination = positional[:-1], positional[-1]
                if verb in {"mv", "move", "move-item"}:
                    for source in sources:
                        add(source)
                target = cwd / destination
                if target.is_dir() or destination.endswith(("/", "\\")):
                    for source in sources:
                        add(str(target / Path(source).name))
                else:
                    add(destination)
        elif verb in {"sed", "perl"} and any(arg.startswith("-i") or (verb == "perl" and arg.startswith("-") and "i" in arg) for arg in clean):
            # The expression precedes file operands in these supported forms.
            positional = [arg for arg in clean if not arg.startswith("-")]
            for arg in positional[1:]:
                add(arg)
        elif verb in {"set-content", "add-content", "out-file", "new-item", "sc", "ac"}:
            for index, arg in enumerate(clean[:-1]):
                if arg.lower() in {"-path", "-literalpath", "-filepath"}:
                    add(clean[index + 1])
                    return
            if clean and not clean[0].startswith("-"):
                add(clean[0])

    for word in words + [";"]:
        if word in {";", "&&", "||", "|", "&", "(", ")"}:
            visit(segment)
            segment = []
        else:
            segment.append(word)
    return found


def full_shell_read(command: str) -> bool:
    words = tokens(command)
    if not words or words[0].lower() not in {"cat", "type", "get-content"}:
        return False
    args = words[1:]
    return len([arg for arg in args if arg.lower() not in {"-raw", "-literalpath", "-path"}]) == 1 and not any(
        arg in {";", "&&", "|", ">", "<", "(", ")"} or "$" in arg or "`" in arg for arg in args
    ) and all(not arg.startswith("-") or arg.lower() in {"-raw", "-literalpath", "-path"} for arg in args)


def shell_read_matches(command: str, output: str, content: str) -> bool:
    return full_shell_read(command) and output.replace("\r\n", "\n").rstrip("\n") == content.replace("\r\n", "\n").rstrip("\n")


def edit_paths(tool: str, args: dict, root: Path) -> list[str]:
    cwd = root / (args.get("workdir") or args.get("cwd") or ".")
    if tool in {"Bash", "bash", "powershell", "exec_command"}:
        return shell_paths(args.get("command", args.get("cmd", "")), root, writing=True, cwd=cwd)
    if tool == "apply_patch":
        patch = args.get("command", args.get("patch", ""))
        if not isinstance(patch, str):
            return []
        return list(dict.fromkeys(str(cwd / match.group(1)) for match in re.finditer(
            r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", patch, re.M)))
    path = args.get("file_path", args.get("path"))
    return [str(cwd / path)] if tool in {"Write", "Edit", "MultiEdit", "write", "edit"} and isinstance(path, str) else []


def read_paths(tool: str, args: dict, root: Path) -> list[str]:
    cwd = root / (args.get("workdir") or args.get("cwd") or ".")
    if tool in {"Bash", "bash", "powershell", "exec_command"}:
        return shell_paths(args.get("command", args.get("cmd", "")), root, cwd=cwd)
    path = args.get("file_path", args.get("path", args.get("filePath")))
    return [str(cwd / path)] if tool in {"Read", "read", "read_file", "view"} and isinstance(path, str) else []


def successful(response) -> bool:
    if isinstance(response, dict):
        if response.get("isError") or response.get("is_error") or response.get("error") or response.get("interrupted") or response.get("success") is False:
            return False
        return response.get("exit_code", response.get("exitCode", 0)) in {0, None}
    if isinstance(response, str):
        status = re.search(r"Process exited with code (\d+)", response)
        if status:
            return status.group(1) == "0"
        if response.startswith(("apply_patch verification failed", "Failed to ", "Error:")):
            return False
    return response is not None


def output_text(response) -> str:
    if isinstance(response, str):
        # Codex unified exec supplies a model-facing envelope.
        match = re.search(r"Process exited with code (\d+)\s*\n.*?Output:\s*\n", response, re.S)
        if match:
            return response[match.end():] if match.group(1) == "0" else ""
        return response
    if isinstance(response, dict):
        for key in ("stdout", "output", "text"):
            if isinstance(response.get(key), str):
                return response[key]
        return output_text(response.get("content", []))
    if isinstance(response, list):
        return "\n".join(item.get("text", "") for item in response if isinstance(item, dict) and item.get("type") == "text")
    return ""


def state_dir(event: dict, root: Path, provider: str) -> Path | None:
    session = event.get("session_id")
    if not session:
        return None
    key = hashlib.sha256(f"{provider}:{root.resolve()}:{session}".encode()).hexdigest()
    return Path(tempfile.gettempdir()) / "harness-path-reads-v1" / key


def observe(event: dict, root: Path, provider: str) -> None:
    directory = state_dir(event, root, provider)
    response = event.get("tool_response")
    if directory is None or event.get("hook_event_name") != "PostToolUse" or not successful(response):
        return
    tool, args = event.get("tool_name"), event.get("tool_input", {})
    records = []
    for raw in read_paths(tool, args, root):
        path = relative(raw, root)
        if path is None:
            continue
        try:
            content = (root / path).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        lines = content.splitlines()
        start, end = 0, len(lines)
        if tool in {"Bash", "bash", "powershell", "exec_command"}:
            if not shell_read_matches(args.get("command", args.get("cmd", "")), output_text(response), content):
                continue
        else:
            file = response.get("file") if isinstance(response, dict) else None
            if not isinstance(file, dict) or not isinstance(file.get("content"), str):
                continue
            start = int(file.get("startLine", args.get("offset", 1))) - 1
            delivered = file["content"].splitlines()
            end = start + len(delivered)
            if start < 0 or not delivered or lines[start:end] != delivered:
                continue
        records.append({"path": path, "digest": hashlib.sha256(content.encode()).hexdigest(), "start": start, "end": end})
    if records:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            temporary = directory / (uuid.uuid4().hex + ".tmp")
            serialized = json.dumps(records)
            temporary.write_text(serialized, encoding="utf-8")
            temporary.replace(directory / (hashlib.sha256(serialized.encode()).hexdigest() + ".json"))
        except OSError:
            pass  # Missing evidence leaves edits blocked; never grants access.


def confirmed_reads(event: dict, needed, root: Path, provider: str) -> set[str]:
    directory = state_dir(event, root, provider)
    if directory is None or not directory.is_dir():
        return set()
    records = []
    for path in directory.glob("*.json"):
        try:
            records.extend(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    found = set()
    for path in needed:
        try:
            content = (root / path).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        digest = hashlib.sha256(content.encode()).hexdigest()
        end = 0
        for start, stop in sorted((r["start"], r["end"]) for r in records if r.get("path") == path and r.get("digest") == digest):
            if start > end:
                break
            end = max(end, stop)
        if end >= len(content.splitlines()):
            found.add(path)
    return found
