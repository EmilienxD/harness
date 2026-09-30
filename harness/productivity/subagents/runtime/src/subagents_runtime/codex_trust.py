"""Preserve the user's TOML while trusting an initialized loop worktree."""

from __future__ import annotations

import os
from pathlib import Path
import uuid

import tomlkit

from subagents_runtime.sessions import SessionError
from subagents_runtime.storage import connect


def trust_worktree(cwd: Path) -> None:
    path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    key = str(cwd.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    # Serialize launches using the same persistent runtime before updating the
    # complete document. A child starts only after the replacement succeeds.
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            original = path.read_text(encoding="utf-8") if path.exists() else ""
            document = tomlkit.parse(original)
            projects = document.setdefault("projects", tomlkit.table())
            entry = projects.setdefault(key, tomlkit.table())
            if entry.get("trust_level") == "trusted":
                return
            entry["trust_level"] = "trusted"
            updated = tomlkit.dumps(document)
            tomlkit.parse(updated)
            temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_text(updated, encoding="utf-8")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            raise SessionError(f"Cannot add Codex worktree trust to {path}: {exc}") from exc
