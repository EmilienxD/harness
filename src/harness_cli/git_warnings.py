"""Warnings for project layouts that Git may not reproduce on checkout."""

from __future__ import annotations

import subprocess
from pathlib import Path


def symlink_worktree_warning(root: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0 or result.stdout.strip() != "true":
        return None
    return (
        "Git worktrees may check out these skill symlinks as plain text files. "
        "Set core.symlinks=true and ensure symlink creation is permitted before "
        "creating a worktree; use copy mode for portable project files."
    )
