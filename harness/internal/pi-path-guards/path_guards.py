"""Versioned Pi path-guard operations using the shipped Python policy cores."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

_common_source = Path(__file__).resolve().parents[1] / "path-guard-common"
sys.path.insert(0, str(_common_source if _common_source.is_dir() else Path(__file__).resolve().parents[1]))
import path_guard_common as common


def core(package: str):
    path = Path(__file__).parent.parent / (package.replace("-", "_") + "_hook.py")
    spec = importlib.util.spec_from_file_location("guard", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relative(path: str, root: Path) -> str | None:
    try:
        return (root / path).resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def reads(request: dict, root: Path) -> list[str]:
    return common.read_paths(request["tool"], request["input"], root)


def observed_reads(request: dict, root: Path) -> list[dict]:
    if request["phase"] != "result" or request.get("isError"):
        return []
    records = []
    for raw in reads(request, root):
        path = relative(raw, root)
        if path is None:
            continue
        try:
            content = (root / path).read_bytes().decode("utf-8", errors="replace")
        except OSError:
            continue
        lines = content.split("\n")
        if request["tool"] == "read":
            args = request["input"]
            start = max(0, int(args.get("offset", 1)) - 1)
            count = min(int(args.get("limit", len(lines))), len(lines) - start)
            truncation = (request.get("details") or {}).get("truncation") or {}
            if truncation.get("firstLineExceedsLimit"):
                count = 0
            elif truncation.get("truncated"):
                count = min(count, truncation["outputLines"])
            delivered = "\n".join(lines[start:start + count])
            if count <= 0 or not request.get("text", "").startswith(delivered):
                continue
        else:
            # Full-file grants require a simple complete read and exact observed bytes.
            command = request["input"].get("command", "")
            if not common.shell_read_matches(command, request.get("text", ""), content):
                continue
            start, count = 0, len(lines)
        records.append({"kind": "read", "path": path, "digest": hashlib.sha256(content.encode()).hexdigest(),
                        "start": start, "end": start + count, "total": len(lines)})
    return records


def complete(path: str, root: Path, receipts: list[dict]) -> bool:
    try:
        content = (root / path).read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return False
    digest = hashlib.sha256(content.encode()).hexdigest()
    end = 0
    ranges = sorted((r["start"], r["end"]) for r in receipts
                    if r.get("kind") == "read" and r.get("path") == path and r.get("digest") == digest)
    for start, stop in ranges:
        if start > end:
            break
        end = max(end, stop)
    return end >= len(content.split("\n"))


def evaluate(request: dict) -> dict:
    if request.get("version") != 1 or request.get("package") not in {
        "on-read-reminder", "on-edit-reminder", "on-edit-block"
    }:
        raise ValueError("unsupported protocol")
    package = request["package"]
    module = core(package)
    root = Path(request["cwd"])
    receipts = request.get("receipts", [])
    records = observed_reads(request, root)
    response = {"version": 1, "block": False, "message": "", "receipts": records}
    edit_paths = common.edit_paths(request["tool"], request["input"], root)
    editing = bool(edit_paths)
    if package == "on-read-reminder":
        if request["phase"] != "result" or request.get("isError"):
            return response
        paths = reads(request, root)
    else:
        if not editing or (package == "on-edit-block") != (request["phase"] == "call") or request.get("isError"):
            return response
        paths = edit_paths
    rules, notes = [], []
    personal = Path(os.environ.get("HARNESS_PI_SUPPORT_DIR", Path(module.__file__).parent)) / module.RULES_NAME
    sources = [personal if personal.is_file() else Path(module.__file__).with_name(module.RULES_NAME),
               Path.home() / ".harness" / "guards" / module.RULES_NAME,
               root / ".harness" / "guards" / module.RULES_NAME]
    for source in dict.fromkeys(p.resolve() for p in sources):
        if source.is_file():
            parsed, bad = module.parse_rules(source)
            rules.extend(parsed)
            if bad:
                key = str(source)
                seen = any(r.get("kind") == "diagnostic" and r.get("path") == key
                           and r.get("package") == package for r in receipts)
                if package == "on-read-reminder" or not seen:
                    notes.append(f"Invalid policy: {module.display_path(source, root)}; fix the TOML schema.")
                    if package != "on-read-reminder":
                        records.append({"kind": "diagnostic", "path": key, "package": package})
    matching = module.matching_reminders if package == "on-read-reminder" else module.matching_files
    required, triggers = [], []
    for raw in paths:
        path = relative(raw, root)
        if path is not None:
            hits = matching(rules, path)
            if hits:
                triggers.append(path)
            required.extend(hits)
    required = list(dict.fromkeys(required))
    if package == "on-read-reminder":
        if required:
            notes.insert(0, f"You just read {', '.join(triggers)}. Read the guidance before continuing: " +
                         ", ".join(f"`{p}`" + (" (missing)" if not (root / p).is_file() else "") for p in required))
    else:
        available = []
        now = time.time()
        delivered = {r.get("path") for r in receipts if r.get("kind") == "delivered" and r.get("package") == package}
        reminded = {r["path"]: r["time"] for r in receipts if r.get("kind") == "reminded" and r.get("package") == package}
        for path in required:
            try:
                content = (root / path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                key = "missing:" + path
                if key not in delivered:
                    notes.append(f"Required guidance `{path}` is unreadable; skipped. Fix the policy or create it.")
                    records.append({"kind": "delivered", "path": key, "package": package})
                continue
            if complete(path, root, receipts + records) or path in delivered:
                continue
            if package == "on-edit-block" or module.due(reminded, path, now):
                available.append((path, content))
        if available and package == "on-edit-block":
            message = module.build_deny_message(triggers[0], available)
            notes.insert(0, message)
            response["block"] = True
            # Only complete content actually included in the denial can authorize a retry.
            for path, content in available:
                if f"\n\n--- {path} ---\n{content}" in message:
                    records.append({"kind": "delivered", "path": path, "package": package})
        elif available:
            notes.insert(0, module.build_message(triggers[0], [p for p, _ in available]))
            records.extend({"kind": "reminded", "path": p, "package": package, "time": now} for p, _ in available)
    response["message"] = "\n".join(notes)
    return response


if __name__ == "__main__":
    try:
        print(json.dumps(evaluate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        print("Pi path guard operation failed", file=sys.stderr)
        sys.exit(1)
