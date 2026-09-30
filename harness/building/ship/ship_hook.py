#!/usr/bin/env python3
"""Provider-neutral PreToolUse policy for runtime-marked loop implementers."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise ValueError("Could not determine checkout boundaries")
    return result.stdout


def tokens(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    lexer.escape = ""
    return list(lexer)


def git_read_only(args: list[str]) -> bool:
    while args and args[0].startswith("-"):
        option = args.pop(0)
        if option in {"-C", "--git-dir", "--work-tree"}:
            if args:
                args.pop(0)
        elif option in {"--no-pager", "--no-optional-locks", "--literal-pathspecs"}:
            continue
        elif option.startswith(("--git-dir=", "--work-tree=")):
            continue
        else:
            return False
    if not args:
        return False
    command, rest = args[0], args[1:]
    if any(a.startswith(("--output", "--exec-path", "--ext-diff", "--textconv")) for a in rest):
        return False
    if command in {"status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "describe", "merge-base", "name-rev", "diff-tree", "diff-index", "shortlog", "blame", "check-ignore"}:
        return True
    if command == "worktree":
        return bool(rest) and rest[0] == "list"
    if command == "branch":
        return not rest or all(a in {"--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color"} or a.startswith(("--format=", "--sort=")) for a in rest)
    if command == "config":
        return bool(rest) and rest[0] in {"--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list"}
    if command == "remote":
        return not rest or rest[0] in {"-v", "--verbose", "get-url"}
    if command == "tag":
        return not rest or rest[0] in {"--list", "-l"}
    return command in {"help", "version"}


def gh_read_only(args: list[str]) -> bool:
    if not args:
        return False
    if args[0] == "api":
        rest = args[1:]
        if not rest or any(a in {"--input"} or a.startswith("--input=") for a in rest):
            return False
        method = None
        fields = []
        for i, arg in enumerate(rest):
            if arg in {"-X", "--method"} and i + 1 < len(rest):
                method = rest[i + 1].upper()
            elif arg.startswith("--method="):
                method = arg.split("=", 1)[1].upper()
            elif arg.startswith("-X"):
                method = arg[2:].upper()
            if arg in {"-f", "-F", "--field", "--raw-field"}:
                if i + 1 >= len(rest):
                    return False
                fields.append(rest[i + 1])
            elif arg.startswith(("-f", "-F")):
                fields.append(arg[2:])
            elif arg.startswith(("--field=", "--raw-field=")):
                fields.append(arg.split("=", 1)[1])
        if rest[0] == "graphql":
            queries = [field[6:].strip() for field in fields if field.startswith("query=")]
            # File input and shell expansion cannot be inspected before execution.
            # Accept only a literal inline query, never an opaque operation.
            return (len(queries) == 1
                    and bool(re.match(r"(?:\{|query\b[^{}]*\{)", queries[0]))
                    and not re.search(r"\bmutation\b|[$`]", queries[0], re.I))
        return method in {"GET", "HEAD"} or method is None and not fields
    if args[0] in {"issue", "pr", "repo", "run", "workflow", "release", "label", "search"}:
        return len(args) >= 2 and args[1] in {"view", "list", "status", "diff", "checks"}
    return args[0] in {"help", "--version"}


def protected_paths(root: Path) -> list[Path]:
    paths = [Path(line[9:]).resolve() for line in git(root, "worktree", "list", "--porcelain").splitlines() if line.startswith("worktree ") and Path(line[9:]).resolve() != root]
    paths.extend([root / "tests/workflow", root / ".git"])
    names = git(root, "ls-files", "-co", "--exclude-standard", "-z").split("\0")
    for name in set(names):
        path = root / name
        if name.endswith(".md") and path.is_file():
            text = path.read_text(encoding="utf-8-sig")
            if re.match(r"\A---\n(?:(?!---\n).)*?^covers:", text, re.S | re.M):
                paths.append(path.resolve())
                if path.parent != root:
                    paths.append(path.parent.resolve())
    return paths


def protected(path: Path, boundaries: list[Path]) -> bool:
    resolved = path.resolve()
    return any(resolved == boundary or resolved.is_relative_to(boundary) or boundary.is_relative_to(resolved) for boundary in boundaries)


def check(payload: dict) -> str | None:
    if os.environ.get("HARNESS_EXECUTION_MODE") != "loop":
        return None
    cwd = Path(payload.get("cwd") or Path.cwd()).resolve()
    root = Path(git(cwd, "rev-parse", "--show-toplevel").strip()).resolve()
    boundaries = protected_paths(root)
    data = payload.get("tool_input") or {}
    if not isinstance(data, dict):
        data = {"patch": data} if isinstance(data, str) else {}
    tool = str(payload.get("tool_name", "")).split(".")[-1]
    candidates = []
    if tool in {"Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "edit_file"}:
        candidates.extend(data[k] for k in ("file_path", "filePath", "path", "notebook_path") if isinstance(data.get(k), str))
        content = data.get("content") or data.get("new_string") or ""
        if isinstance(content, str) and re.match(r"\A---\r?\n(?:(?!---\r?\n).)*?^covers:", content, re.S | re.M):
            return "The Lead creates and edits test workflows. Report the required workflow change."
    if tool == "apply_patch":
        patch = data.get("patch") or data.get("command") or data.get("input") or ""
        candidates.extend(re.findall(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", patch, re.M))
    if tool in {"Bash", "PowerShell", "exec_command", "shell", "shell_command"}:
        command = data.get("command") or data.get("cmd") or ""
        if isinstance(data.get("workdir"), str):
            cwd = Path(data["workdir"]).resolve()
        words = tokens(command)
        for i, word in enumerate(words[:-1]):
            if word.lower() in {"-c", "-command", "/c"}:
                nested = words[i + 1]
                if re.search(r"(?:^|[\s;&|])(?:git|gh)(?:\.exe)?\s", nested):
                    reason = check({**payload, "tool_input": {"command": nested}})
                    if reason:
                        return reason
        for i, word in enumerate(words):
            executable = re.split(r"[/\\]", word)[-1].lower().removesuffix(".exe")
            if executable in {"git", "gh"}:
                tail = []
                for arg in words[i + 1:]:
                    if arg in {";", "&&", "||", "|", "&", ")"}:
                        break
                    tail.append(arg)
                if not (git_read_only(tail) if executable == "git" else gh_read_only(tail)):
                    return "The Lead owns Git and GitHub mutations. Use read-only commands and report the required mutation."
        # Resolve simple directory changes before examining destinations.
        for i, word in enumerate(words[:-1]):
            if word.lower() in {"cd", "chdir", "set-location", "push-location"}:
                target = words[i + 1]
                if target.startswith("-") or any(c in target for c in "$`%*"):
                    return "Use an explicit working directory so checkout boundaries can be checked."
                cwd = (cwd / target).resolve()
        read_commands = {"cat", "type", "get-content", "ls", "dir", "get-childitem", "rg", "grep", "head", "tail", "pwd", "git", "gh"}
        has_write = any(w in {">", ">>", "2>"} for w in words)
        simple_read = bool(words) and words[0].lower() in read_commands and not has_write and not any(w in {";", "&&", "|", "||"} for w in words)
        if not simple_read:
            candidates.extend(w for w in words if w and not w.startswith("-") and w not in {";", "&&", "|", "||", ">", ">>"})
            # Embedded scripts and redirections may contain a protected literal
            # without it being a standalone shell argument.
            normalized = command.replace("\\", "/").casefold()
            for boundary in boundaries:
                if boundary.as_posix().casefold() in normalized:
                    return "The Lead owns workflow files and other checkouts. Write implementation and evidence in permitted paths."
                if boundary.is_relative_to(root) and boundary.relative_to(root).as_posix().casefold() in normalized:
                    return "The Lead owns workflow files and other checkouts. Write implementation and evidence in permitted paths."
    if any(protected(cwd / candidate, boundaries) for candidate in candidates):
        return "The Lead owns workflow files and other checkouts. Write implementation and evidence in permitted paths."
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        reason = check(payload) if isinstance(payload, dict) else None
    except (ValueError, OSError) as error:
        reason = f"Loop guard could not check this action: {error}" if os.environ.get("HARNESS_EXECUTION_MODE") == "loop" else None
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
