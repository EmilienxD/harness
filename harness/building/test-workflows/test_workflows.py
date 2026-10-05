#!/usr/bin/env python3
"""Portable workflow hashes, CLI, and provider hook handler (stdlib only)."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SECTIONS = ("Preconditions", "Steps", "Acceptance Criteria", "Potential Problems")


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return result.stdout


def repository(cwd: Path) -> Path:
    return Path(git(cwd, "rev-parse", "--show-toplevel").strip()).resolve()


def scalar(text: str):
    text = text.strip()
    if text in {"null", "~", ""}:
        return None
    if text.startswith(('"', "'", "[", "{")):
        try:
            return json.loads(text)
        except ValueError:
            try:
                return ast.literal_eval(text)
            except (ValueError, SyntaxError):
                if text.startswith("[") and text.endswith("]"):
                    return [scalar(item) for item in text[1:-1].split(",") if item.strip()]
                raise
    return text.split(" #", 1)[0].strip()


def read_workflow(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8-sig")
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)(.*)\Z", text, re.S)
    if not match:
        raise ValueError("workflow requires front matter")
    fields: dict = {}
    current = None
    for line in match[1].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.lstrip().startswith("- ") and current == "covers":
            fields.setdefault("covers", []).append(scalar(line.strip()[2:]))
            continue
        key, separator, value = line.partition(":")
        if not separator or key.strip() not in {"covers", "verified_hash", "verified_files"}:
            raise ValueError("supported front matter fields: covers, verified_hash, verified_files")
        current = key.strip()
        fields[current] = [] if current == "covers" and not value.strip() else scalar(value)
    covers = fields.get("covers")
    if not isinstance(covers, list) or not covers or not all(isinstance(p, str) and p and not Path(p).is_absolute() and ".." not in p.replace("\\", "/").split("/") for p in covers):
        raise ValueError("covers must be a nonempty list of repository-relative globs")
    for section in SECTIONS:
        if not re.search(r"^## " + re.escape(section) + r"\s*$", match[2], re.M):
            raise ValueError(f"missing section: {section}")
    inventory = fields.get("verified_files")
    if inventory is not None and (not isinstance(inventory, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in inventory.items())):
        raise ValueError("verified_files must be the generated per-file hash map")
    return fields, match[2]


def workflow_paths(root: Path, directory: str | None = None) -> list[Path]:
    if directory:
        folder = (root / directory).resolve()
        if not folder.is_relative_to(root):
            raise ValueError("workflow directory must be inside the repository")
        return sorted(folder.rglob("*.md"))
    # Discover the format wherever project instructions place it. This avoids
    # interpreting arbitrary prose as configuration and protects custom folders.
    names = git(root, "ls-files", "-co", "--exclude-standard", "-z").split("\0")
    result = []
    for name in sorted(set(names)):
        path = root / name
        if name.endswith(".md") and path.is_file() and path.resolve().is_relative_to(root):
            text = path.read_text(encoding="utf-8-sig")
            if re.match(r"\A---\n(?:(?!---\n).)*?^covers:", text, re.S | re.M):
                result.append(path)
    return result


def covered_files(root: Path, fields: dict) -> dict[str, str]:
    files = {}
    for pattern in fields["covers"]:
        for path in root.glob(pattern.replace("\\", "/")):
            if path.is_file() and path.resolve().is_relative_to(root) and ".git" not in path.relative_to(root).parts:
                content = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                files[path.relative_to(root).as_posix()] = hashlib.sha256(content).hexdigest()
    return dict(sorted(files.items()))


def digest(files: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def inspect_workflow(root: Path, path: Path) -> dict:
    result = {"workflow": path.relative_to(root).as_posix()}
    try:
        fields, _ = read_workflow(path)
        files = covered_files(root, fields)
        previous = fields.get("verified_files") or {}
        result.update(state="broken" if not files else "passed" if fields.get("verified_hash") == digest(files) else "stale",
                      current_hash=digest(files), files=files, covers=fields["covers"],
                      changed_files=sorted(name for name in files.keys() | previous.keys() if files.get(name) != previous.get(name)))
        if result["state"] == "passed":
            result["changed_files"] = []
    except (ValueError, SyntaxError, OSError, TypeError) as error:
        result.update(state="invalid", error=str(error), changed_files=[])
    return result


def confirm(root: Path, path: Path) -> dict:
    path = path.resolve()
    if not path.is_relative_to(root):
        raise ValueError("workflow must be inside this checkout")
    fields, body = read_workflow(path)
    files = covered_files(root, fields)
    if not files:
        raise ValueError("covers matches no file")
    fields["verified_hash"] = digest(files)
    fields["verified_files"] = files
    front = "\n".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in fields.items())
    path.write_text(f"---\n{front}\n---\n{body}", encoding="utf-8", newline="\n")
    return inspect_workflow(root, path)


def edited_paths(payload: dict) -> list[str]:
    tool = str(payload.get("tool_name", "")).split(".")[-1]
    if tool not in {"Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "edit_file"}:
        return []
    data = payload.get("tool_input") or {}
    if not isinstance(data, dict):
        return []
    paths = [data[key] for key in ("file_path", "filePath", "path") if isinstance(data.get(key), str)]
    if tool == "apply_patch":
        patch = data.get("patch") or data.get("command") or data.get("input") or ""
        paths.extend(re.findall(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", patch, re.M))
    return paths


def covers_changed(record: dict, changed: set[str]) -> bool:
    if changed.intersection(set(record.get("files", {})) | set(record.get("changed_files", []))):
        return True
    # A deleted last match still affects an unstamped workflow. Match the glob
    # against changed names even when there are no current files to enumerate.
    for pattern in record.get("covers", []):
        expression = re.escape(pattern.replace("\\", "/"))
        expression = expression.replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*").replace(r"\?", "[^/]")
        if any(re.fullmatch(expression, name) for name in changed):
            return True
    return False


def hook(payload: dict, provider: str) -> dict | None:
    root = repository(Path(payload.get("cwd") or Path.cwd()))
    records = [inspect_workflow(root, path) for path in workflow_paths(root)]
    current = {name: value for record in records for name, value in record.get("files", {}).items()}
    identifier = str(payload.get("session_id") or payload.get("thread_id") or "unknown")
    key = hashlib.sha256(f"{root}\0{identifier}".encode()).hexdigest()
    state_root = Path(os.environ.get("HARNESS_STATE_DIR", str(Path.home() / ".harness")))
    state_file = state_root / "test-workflows" / f"{key}.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {"baseline": current, "noticed": [], "blocked": False}
        # When installed mid-session, Stop still accounts for uncommitted work.
        if payload.get("hook_event_name") == "Stop":
            dirty = git(root, "diff", "--name-only", "HEAD", "-z").split("\0")
            dirty += git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
            state["baseline"] = {name: value for name, value in current.items() if name not in dirty}
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        state["blocked"] = False
    baseline = state["baseline"]
    changed = {name for name in current.keys() | baseline.keys() if current.get(name) != baseline.get(name)}
    output = None
    affected = []
    if event == "PostToolUse":
        for name in edited_paths(payload):
            path = (root / name).resolve()
            if path.is_relative_to(root):
                changed.add(path.relative_to(root).as_posix())
        affected = [r["workflow"] for r in records if r["workflow"] not in state["noticed"] and covers_changed(r, changed)]
        state["noticed"].extend(affected)
    # Provider hooks run concurrently. The runtime owns loop Stop decisions,
    # including release; an independent workflow block would override release.
    elif event == "Stop" and os.environ.get("HARNESS_EXECUTION_MODE") != "loop" and not state["blocked"]:
        affected = [r["workflow"] for r in records if r["state"] != "passed" and covers_changed(r, changed)]
        if affected:
            state["blocked"] = True
    if affected:
        loop = os.environ.get("HARNESS_EXECUTION_MODE") == "loop"
        message = ("Run these test workflows and report each result and evidence path to the Lead: " if loop else
                   "Run these test workflows and confirm passing ones with `test-workflows confirm <workflow>`, or explain why one stays unconfirmed: ") + ", ".join(affected)
        # Codex rejects hook output containing any field outside its schema.
        if event == "Stop":
            output = {"decision": "block", "reason": message}
        else:
            output = {"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}}
    state_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_file.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state), encoding="utf-8")
    temporary.replace(state_file)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="test-workflows")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--directory", help="workflow folder from project instructions; format discovery is the default")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    stamp = commands.add_parser("confirm")
    stamp.add_argument("workflow", type=Path)
    hooks = commands.add_parser("hook")
    hooks.add_argument("--provider", choices=("claude", "chatgpt"), default="claude")
    args = parser.parse_args(argv)
    try:
        if args.command == "hook":
            payload = json.load(sys.stdin)
            if isinstance(payload, dict):
                result = hook(payload, args.provider)
                if result:
                    print(json.dumps(result))
            return 0
        root = repository(args.root)
        if args.command == "confirm":
            if os.environ.get("HARNESS_EXECUTION_MODE") == "loop":
                raise ValueError("Only the Lead stamps workflows in a loop")
            result = confirm(root, args.workflow if args.workflow.is_absolute() else root / args.workflow)
        else:
            result = {"workflows": [inspect_workflow(root, p) for p in workflow_paths(root, args.directory)]}
        print(json.dumps(result))
        return int(args.command == "status" and any(w["state"] != "passed" for w in result["workflows"]))
    except (ValueError, OSError, SyntaxError) as error:
        if args.command == "hook":
            # Non-repository sessions and malformed provider input are inert.
            return 0
        print(json.dumps({"error": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
