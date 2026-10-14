"""Pi advisory policy over immutable, native-queue mutation snapshots."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import prefer_fewer_comments_hook as core


def evaluate(request: dict) -> dict:
    if request.get("version") != 1:
        raise ValueError("Unsupported protocol")
    root = Path(request["cwd"])
    path, old, new = request["path"], request["before"], request["after"]
    if not all(isinstance(value, str) for value in (path, old, new)):
        raise ValueError("Invalid snapshot")
    limits = dict(core.DEFAULT_LIMITS)
    patterns = []
    for source in core.rules_sources(root):
        overrides, rules = core.parse_rules(source)
        limits.update(overrides)
        patterns.extend(rules)
    relative = core.normalise(path, root)
    identity = os.path.normcase(str(Path(path).resolve())).replace("\\", "/")
    family = core.family_for(path)
    response = {"version": 1, "message": "", "receipts": []}
    if family is None or core.exempt(patterns, relative):
        return response
    receipts = request.get("receipts", [])
    now = time.time()
    if any(item.get("path") == identity and now - item["stamp"] < core.REMIND_INTERVAL_SECONDS for item in receipts):
        return response
    # BOM and line-ending normalization alone introduce no commentary.
    old, new = old.lstrip("\ufeff"), new.lstrip("\ufeff")
    added = core.added_indices(old, new)
    if not added:
        return response
    items = core.findings(new, added, family, limits, previous=old)
    if items:
        response["message"] = core.build_message([(relative, items)], limits, not receipts)[:core.MESSAGE_LIMIT]
        response["receipts"] = [{"path": identity, "stamp": now}]
    return response


if __name__ == "__main__":
    print(json.dumps(evaluate(json.load(sys.stdin))))
