"""Pi commit adapter: verified Git effects and native active-branch receipts.

The extension owns event ancestry. This helper owns Git, hashes and the shared
commit flow. Snapshots stay in memory; receipts contain paths/hashes, never file
contents or prompts. Attribution errors fail closed instead of staging a tree.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

import commit_hook as core

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_PATHS = 4096


def git(root: str, *args: str) -> str:
    result = core.run(["git", *args], root)
    if result.returncode:
        raise ValueError("Git attribution failed")
    return result.stdout


def fingerprint(root: str, relative: str) -> list:
    path = Path(root) / relative
    # A link can mutate a different Git path (or a different repository).
    if os.path.normcase(str(path.resolve())) != os.path.normcase(os.path.abspath(path)):
        raise ValueError("Linked commit targets are unsupported")
    try:
        metadata = path.stat()
    except FileNotFoundError:
        return ["missing"]
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_FILE_BYTES:
        raise ValueError("Commit target is not a bounded regular file")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return ["file", digest, bool(metadata.st_mode & stat.S_IXUSR)]


def dirty(root: str) -> set[str]:
    paths = set()
    for args in [("diff", "--name-only", "-z"), ("diff", "--cached", "--name-only", "-z"),
                 ("ls-files", "--others", "--exclude-standard", "-z")]:
        paths.update(p for p in git(root, *args).split("\0") if p)
    if len(paths) > MAX_PATHS:
        raise ValueError("Git attribution path limit")
    return paths


def relative(root: str, path: str) -> str | None:
    try:
        return Path(os.path.abspath(path)).relative_to(Path(root)).as_posix()
    except ValueError:
        return None


def snapshot(request: dict, root: str) -> dict:
    # Only shell operations need a whole dirty-tree inventory. Native calls are
    # scoped to the exact resolved path and compose with other tool overrides.
    paths = dirty(root)
    target = relative(root, request.get("path", "")) if request.get("path") else None
    shell = request.get("tool") in {"bash", "powershell"}
    targets, resolved = core.shell_write_targets(request.get("command", "")) if shell else ([], True)
    if request.get("tool") == "powershell":
        deletion = re.fullmatch(r"\s*Remove-Item\s+-(?:LiteralPath|Path)\s+(?:'([^']+)'|\"([^\"]+)\"|([^\s;|&]+))\s*", request.get("command", ""), re.I)
        if deletion:
            targets = [next(value for value in deletion.groups() if value)]
            resolved = not bool(core.COMPUTED.search(targets[0]))
    expected = {value for p in targets if (value := relative(root, core._abs(p, request["cwd"]))) is not None}
    observed = paths | expected if shell else {target} if target else set()
    head = core.run(["git", "rev-parse", "HEAD"], root)
    return {"repo": root, "head": head.stdout.strip() if head.returncode == 0 else None,
            "paths": {p: fingerprint(root, p) for p in sorted(observed)},
            "dirty": sorted(paths), "target": target, "expected": sorted(expected), "resolved": resolved}


def owned(receipts: list[dict]) -> tuple[dict, list[str], str | None]:
    paths, uncertain, head = {}, [], None
    for entry in receipts:
        if entry.get("kind") == "baseline":
            paths, uncertain, head = {}, [], entry.get("head")
        elif entry.get("kind") == "write":
            if head is None:
                head = entry.get("head")
            paths.update(entry.get("paths", {}))
        elif entry.get("kind") == "uncertain":
            uncertain.append(entry.get("reason", "Uncertain tool effects"))
    return paths, uncertain, head


def observe(request: dict, root: str) -> dict:
    before = request.get("before")
    after = snapshot(request, root)
    if not isinstance(before, dict) or before.get("repo") != root:
        return {"receipts": [{"kind": "uncertain", "reason": "Pre-tool snapshot unavailable"}]}
    if request.get("tool") == "write" and not request.get("isError") and after.get("target"):
        observed = after["paths"].get(after["target"], [])
        if not request.get("expectedDigest") or len(observed) < 2 or observed[1] != request["expectedDigest"]:
            return {"receipts": [{"kind": "uncertain", "reason": "Observed write bytes differ from the native tool input"}]}
    changed = {p: after["paths"].get(p, ["missing"])
               for p in set(before["paths"]) | set(after["paths"])
               if before["paths"].get(p, ["missing"]) != after["paths"].get(p, ["missing"])}
    records = []
    previous, _, _ = owned(request.get("receipts", []))
    if before["head"] != after["head"]:
        records.append({"kind": "baseline", "head": after["head"]})
        # A checkout/reset changes clean files too; they belong to Git's new
        # baseline. Residual dirty effects cannot be confidently separated.
        changed = {p: value for p, value in changed.items() if p in after["dirty"]}
        previous = {}
    if not changed:
        return {"receipts": records}
    reason = None
    if request.get("isError"):
        reason = "A failed tool changed repository files"
    elif request.get("overlap"):
        reason = "Concurrent tool snapshots overlap"
    elif before["head"] != after["head"]:
        reason = "A Git baseline change left dirty tool effects"
    elif request.get("tool") in {"bash", "powershell"} and (not before["resolved"] or set(changed) - set(before["expected"])):
        reason = "Shell effects exceed its recognizable literal write targets"
    elif any(p in before["dirty"] and previous.get(p) != before["paths"].get(p) for p in changed):
        reason = "The tool changed a file containing preexisting or foreign work"
    if reason:
        records.append({"kind": "uncertain", "reason": reason})
    else:
        records.append({"kind": "write", "head": after["head"], "paths": changed})
    return {"receipts": records}


class Completed(Exception):
    def __init__(self, message: str):
        self.message = message


def perform_commit(request: dict, root: str) -> dict:
    flags, message = core.split_flags(request.get("args", ""))
    if not message and not flags.dry and not flags.use_ai:
        return {"message": core.USAGE, "receipts": []}
    paths, uncertain, head = owned(request.get("receipts", []))
    if uncertain:
        return {"message": "Commit stopped: " + "; ".join(dict.fromkeys(uncertain)) + ". Review and commit these changes manually.", "receipts": []}
    if not paths:
        return {"message": "No verified writes on the active Pi session branch. Nothing was staged or committed.", "receipts": []}
    current = core.run(["git", "rev-parse", "HEAD"], root)
    current_head = current.stdout.strip() if current.returncode == 0 else None
    if current_head != head:
        return {"message": "Commit stopped: Git HEAD changed outside the observed tools. Review the working tree manually.", "receipts": []}
    if any(fingerprint(root, p) != expected for p, expected in paths.items()):
        return {"message": "Commit stopped: an attributed file changed after its observed write. Review the working tree manually.", "receipts": []}
    if core.in_merge(root):
        return {"message": "Commit stopped: a merge requires committing the whole index. Finish the merge manually.", "receipts": []}
    # Even partial staging of an owned file is an independent user decision.
    staged = set(git(root, "diff", "--cached", "--name-only", "-z").split("\0"))
    previous_staged = next((entry.get("index", {}) for entry in reversed(request.get("receipts", []))
                            if entry.get("kind") in {"staged", "baseline"}), {})
    def index_fingerprint(path: str) -> str:
        return hashlib.sha256(git(root, "ls-files", "--stage", "-z", "--", path).encode("utf-8")).hexdigest()
    if any(previous_staged.get(path) != index_fingerprint(path) for path in staged.intersection(paths)):
        return {"message": "Commit stopped: an attributed file already has staged changes. Preserve or unstage those changes explicitly before retrying.", "receipts": []}
    absolute, ignored = core.filter_ignored([str(Path(root) / p) for p in paths], root)
    if not absolute:
        return {"message": "No non-ignored verified writes to commit.", "receipts": []}
    scan = core.WriteScan(absolute, [], [], ignored, len(paths), len(paths), [])
    context = []
    for event in request.get("context", []):
        role, text = event.get("role"), event.get("text")
        if role in {"user", "assistant"} and isinstance(text, str):
            context.append(role.upper() + ": " + core._truncate(core._clean_prompt_text(text), 900 if role == "user" else 260))
    core.set_provider(core.PI)
    def finish(value: str):
        raise Completed(value)
    core.finish = finish
    committed = False
    owned_index = {}
    def staged_snapshot():
        owned_index.update({p: index_fingerprint(p) for p in paths})
    def cleanup():
        nonlocal committed
        committed = True
    def verify():
        now = core.run(["git", "rev-parse", "HEAD"], root)
        now_head = now.stdout.strip() if now.returncode == 0 else None
        if now_head != head or core.in_merge(root) or any(fingerprint(root, p) != expected for p, expected in paths.items()):
            finish("Commit stopped: repository state changed while preparing the commit. Staged changes were preserved for review.")
        if git(root, "diff", "--name-only", "-z", "--", *absolute).strip("\0"):
            finish("Commit stopped: attributed files changed after staging. Staged changes were preserved for review.")
        if any(index_fingerprint(p) != expected for p, expected in owned_index.items()):
            finish("Commit stopped: the index changed while preparing the commit. Staged changes were preserved for review.")
    try:
        core.commit({"session_id": request["sessionId"]}, root, scan, "", flags, message, "", cleanup,
                    session_context="\n".join(context), before_commit=verify, after_stage=staged_snapshot)
    except Completed as result:
        receipts = [{"kind": "baseline", "head": git(root, "rev-parse", "HEAD").strip()}] if committed else []
        if not committed and owned_index:
            # A failed AI request/commit leaves owned staging for an explicit
            # message retry. Only the exact index entries we staged are owned.
            receipts = [{"kind": "staged", "index": owned_index}]
        return {"message": result.message, "receipts": receipts}
    raise ValueError("Commit flow did not settle")


def evaluate(request: dict) -> dict:
    if request.get("version") != 1:
        raise ValueError("Unsupported Pi commit protocol")
    root = core._repo_root(request["cwd"])
    if root is None:
        return {"version": 1, "message": "Not a git repository -- nothing to commit.", "receipts": [], "snapshot": None}
    operation = request["operation"]
    if operation == "snapshot":
        response = {"snapshot": snapshot(request, root)}
    elif operation == "observe":
        response = observe(request, root)
    elif operation == "commit":
        response = perform_commit(request, root)
    else:
        raise ValueError("Unsupported Pi commit operation")
    return {"version": 1, **response}


if __name__ == "__main__":
    os.environ["GIT_LITERAL_PATHSPECS"] = "1"
    try:
        result = evaluate(json.load(sys.stdin))
    except Exception:
        result = {"version": 1, "error": True, "message": "Harness Pi commit failed safely. Check Git, the Python helper and file readability; nothing was broadened to unrelated changes.", "receipts": []}
    print(json.dumps(result, ensure_ascii=False))
