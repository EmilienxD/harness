#!/usr/bin/env python3
"""Bounded native Pi inventory transport; the shared core owns Git facts."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

from cleanup_git import FactError, prepared_inventory


def main() -> None:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or request.get("version") != 1:
            raise ValueError("Unsupported Pi cleanup request")
        cwd = request.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            raise ValueError("Missing cleanup working directory")
        response = {"version": 1, "ok": True, "message": prepared_inventory(Path(cwd))}
    except (ValueError, OSError, FactError, subprocess.TimeoutExpired):
        response = {"version": 1, "ok": False,
                    "message": "Git cleanup inventory failed. Resolve repository access and Git availability, then retry; no cleanup was performed."}
    print(json.dumps(response, ensure_ascii=True))


if __name__ == "__main__":
    main()
