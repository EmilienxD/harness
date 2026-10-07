#!/usr/bin/env python3
"""Portable workflow hashes and explicit confirmation CLI (stdlib only)."""
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

SECTIONS = ("Steps", "Acceptance Criteria")


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
        raise ValueError("workflow requires covers in front matter")
    fields: dict = {}
    current = None
    for line in match[1].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.lstrip().startswith("- ") and current == "covers":
            fields["covers"].append(scalar(line.strip()[2:]))
            continue
        key, separator, value = line.partition(":")
        if not separator or key.strip() != "covers":
            raise ValueError("supported front matter field: covers")
        current = key.strip()
        fields[current] = [] if not value.strip() else scalar(value)
    covers = fields.get("covers")
    if not isinstance(covers, list) or not covers or not all(isinstance(p, str) and p and not Path(p).is_absolute() and ".." not in p.replace("\\", "/").split("/") for p in covers):
        raise ValueError("covers must be a nonempty list of repository-relative globs")
    for section in SECTIONS:
        if not re.search(r"^## " + re.escape(section) + r"\s*$", match[2], re.M):
            raise ValueError(f"missing section: {section}")
    manifest = path.with_suffix(".manifest.json")
    try:
        verification = json.loads(manifest.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        verification = {}
    if not isinstance(verification, dict) or set(verification) - {"verified_hash", "verified_files"}:
        raise ValueError("supported manifest fields: verified_hash, verified_files")
    fields.update(verification)
    if fields.get("verified_hash") is not None and not isinstance(fields["verified_hash"], str):
        raise ValueError("verified_hash must be a string or null")
    inventory = fields.get("verified_files")
    if inventory is not None and (not isinstance(inventory, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in inventory.items())):
        raise ValueError("verified_files must be the generated per-file hash map")
    return fields, text


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
    fields, _ = read_workflow(path)
    files = covered_files(root, fields)
    if not files:
        raise ValueError("covers matches no file")
    manifest = path.with_suffix(".manifest.json")
    if not manifest.resolve().is_relative_to(root):
        raise ValueError("workflow manifest must be inside this checkout")
    verification = {"verified_hash": digest(files), "verified_files": files}
    manifest.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return inspect_workflow(root, path)


def render_toon(result: dict) -> str:
    """Encode the CLI's objects, string arrays and workflow lists as TOON 4.3."""
    def quoted(value: str) -> str:
        escapes = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}
        return '"' + "".join(escapes.get(c, f"\\u{ord(c):04x}" if ord(c) < 32 else c)
                             for c in value) + '"'

    def string(value: str) -> str:
        if (not value or value != value.strip(" \t") or value in {"true", "false", "null"}
                or value.startswith(("-", "#"))
                or re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?", value, re.I)
                or any(c in ':"\\[]{},' or ord(c) < 32 for c in value)):
            return quoted(value)
        return value

    def fields(value: dict, depth: int) -> list[str]:
        lines = []
        prefix = "  " * depth
        for name, item in value.items():
            key = name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) else quoted(name)
            if isinstance(item, dict):
                lines.extend([f"{prefix}{key}:", *fields(item, depth + 1)])
            elif isinstance(item, list):
                if not item:
                    lines.append(f"{prefix}{key}: []")
                elif all(isinstance(entry, str) for entry in item):
                    lines.append(f"{prefix}{key}[{len(item)}]: " + ",".join(string(entry) for entry in item))
                else:
                    lines.append(f"{prefix}{key}[{len(item)}]:")
                    for entry in item:
                        body = fields(entry, depth + 2)
                        lines.extend([prefix + "  - " + body[0].lstrip(), *body[1:]])
            else:
                lines.append(f"{prefix}{key}: {string(item)}")
        return lines

    return "\n".join(fields(result, 0))


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    parser = argparse.ArgumentParser(
        prog="test-workflows",
        description="Check workflow verification against covered files and record passing manual runs. Output is TOON by default.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""States:
  passed   Covered files match the recorded verification.
  stale    Run the workflow again and confirm if it passes.
  broken   Fix covers: no files matched.
  invalid  Fix the workflow format or manifest.

Exit codes:
  0  Success; status reports every discovered workflow as passed.
  1  Status found stale, broken, or invalid workflows.
  2  Command error.""")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="checkout location (default: current checkout)")
    parser.add_argument("--directory", help="limit status discovery to a repository-relative folder (default: tracked/non-ignored Markdown with covers front matter)")
    parser.add_argument("--json", action="store_true", help="output JSON instead of TOON")
    commands = parser.add_subparsers(dest="command", required=True)
    status = commands.add_parser("status", help="report workflow states and changed files",
                                 description="Report workflow states and changed files. Output is TOON by default; use --json for JSON.")
    stamp = commands.add_parser("confirm", help="record a passing manual run",
                                description="After performing a workflow and verifying it passes, record covered file hashes in its manifest. Output is TOON by default.")
    stamp.add_argument("workflow", type=Path, help="workflow Markdown path relative to the repository (absolute paths inside the checkout also accepted)")
    for command in (status, stamp):
        command.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="output JSON instead of TOON")
    args = parser.parse_args(argv)
    try:
        root = repository(args.root)
        if args.command == "confirm":
            if os.environ.get("HARNESS_EXECUTION_MODE") == "loop":
                raise ValueError("Only the Lead stamps workflows in a loop")
            result = confirm(root, args.workflow if args.workflow.is_absolute() else root / args.workflow)
        else:
            result = {"workflows": [inspect_workflow(root, p) for p in workflow_paths(root, args.directory)]}
        print(json.dumps(result, ensure_ascii=False) if args.json else render_toon(result))
        return int(args.command == "status" and any(w["state"] != "passed" for w in result["workflows"]))
    except (ValueError, OSError, SyntaxError) as error:
        result = {"error": str(error)}
        print(json.dumps(result, ensure_ascii=False) if args.json else render_toon(result))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
