"""Conservative directory-only inbox pruning; persistent assignments are never removed."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import stat

from subagents_runtime.storage import connect, state_dir


def redirected(path: Path) -> bool:
    """Reject symlinks and Windows reparse points (including directory junctions)."""
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def observe_activity(session_id: str, *, ended: bool = False) -> None:
    with connect() as db:
        db.execute(
            """INSERT INTO inbox_activity(session_id,last_seen,ended_at)
               VALUES (?,CURRENT_TIMESTAMP,CASE WHEN ? THEN CURRENT_TIMESTAMP END)
               ON CONFLICT(session_id) DO UPDATE SET
                 last_seen=CURRENT_TIMESTAMP, ended_at=excluded.ended_at""",
            (session_id, ended),
        )


@dataclass(frozen=True)
class CleanupResult:
    path: Path
    status: str
    reason: str


def cleanup_inboxes(
    *, apply: bool = False, grace_hours: float = 168, offline: bool = False,
    session_id: str | None = None,
) -> list[CleanupResult]:
    """Prune only empty managed directories, serialized with lifecycle/assignment writes.

    Offline is an explicit caller assertion that ALL provider sessions using this
    state directory have stopped. It permits pruning legacy/crashed sessions whose
    lifecycle cannot otherwise be established. Outstanding work is still protected.
    """
    import math

    if not math.isfinite(grace_hours) or grace_hours < 0:
        raise ValueError("grace hours must be finite and nonnegative")
    root = state_dir() / "inboxes"
    if not root.exists():
        return []
    if redirected(root) or root.resolve() != root:
        return [CleanupResult(root, "skipped", "inbox root is redirected")]
    results = []
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        assignments = {
            Path(path): owner for owner, path in db.execute(
                "SELECT parent_session_id,inbox FROM session_delegation"
            )
        }
        candidates = (
            [path for path, owner in assignments.items() if owner == session_id and path.parent == root]
            if session_id is not None else sorted(root.iterdir())
        )
        for path in candidates:
            owner = assignments.get(path)
            if session_id is not None and owner != session_id:
                continue
            reason = None
            try:
                if redirected(path) or path.resolve() != path or not path.is_dir():
                    reason = "not a canonical real directory"
                elif owner is None and not offline:
                    reason = "unreferenced directory; liveness unknown (requires --offline)"
                elif owner is not None:
                    activity = db.execute(
                        "SELECT ended_at, julianday('now')-julianday(last_seen) FROM inbox_activity WHERE session_id=?",
                        (owner,),
                    ).fetchone()
                    if not offline and (not activity or activity[0] is None):
                        reason = "session not known to have ended (requires --offline)"
                    elif not offline and (activity[1] is None or activity[1] * 24 < grace_hours):
                        reason = "within inactivity grace period"
                    # Include descendants: a parent inbox can be empty while its children work.
                    busy = db.execute(
                        """WITH RECURSIVE family(id) AS (
                             SELECT ? UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_session_id=f.id
                           ) SELECT 1 FROM executions WHERE session_id IN family
                             AND superseded_at IS NULL AND state IN ('prepared','starting','running','uncertain')
                           UNION ALL SELECT 1 FROM requests WHERE parent_session_id IN family
                             AND state IN ('launching','pending','uncertain')
                           UNION ALL SELECT 1 FROM loop_sessions WHERE session_id IN family AND active=1
                           LIMIT 1""",
                        (owner,),
                    ).fetchone()
                    if busy:
                        reason = "active or uncertain execution, request, or loop work"
                if reason is None:
                    if any(path.iterdir()):
                        reason = "directory is not empty"
                    elif apply:
                        # Never recurse: a concurrent writer makes rmdir fail rather than lose data.
                        path.rmdir()
                        results.append(CleanupResult(path, "removed", "empty inactive inbox"))
                    else:
                        results.append(CleanupResult(path, "would-remove", "empty inactive inbox"))
                if reason is not None:
                    results.append(CleanupResult(path, "skipped", reason))
            except OSError as exc:
                results.append(CleanupResult(path, "skipped", str(exc)))
    return results
