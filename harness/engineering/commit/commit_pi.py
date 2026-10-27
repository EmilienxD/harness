"""Pi commit adapter: verified Git effects and native active-branch receipts.

The extension owns event ancestry. This helper owns Git, hashes and the shared
commit flow. Snapshots stay in memory; receipts contain paths/hashes, never file
contents or prompts. Attribution errors fail closed instead of staging a tree.
"""
from __future__ import annotations

import json
import os
import sys

import commit_hook as core

from commit_ownership import Ownership

ownership = Ownership(core)
git = ownership.git
fingerprint = ownership.fingerprint
dirty = ownership.dirty
relative = ownership.relative
snapshot = ownership.snapshot
owned = ownership.owned
observe = ownership.observe
def perform_commit(request: dict, root: str) -> dict:
    core.set_provider(core.PI)
    return ownership.perform_commit(request, root)


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
