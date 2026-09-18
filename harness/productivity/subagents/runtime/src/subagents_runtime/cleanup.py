"""Best-effort retention of disposable execution artifacts."""

from __future__ import annotations

import shutil
import sqlite3
import time
from pathlib import Path


def cleanup_inactive_executions(connection, state_root: Path) -> None:
    """Keep durable conversation state; prune artifacts after seven idle days.

    Run under the database write lock so a new execution cannot be reserved
    between checking its conversation and removing its old artifacts.
    """
    cutoff = time.time() - 7 * 86400
    runtime_root = state_root / "runtime" / "sessions"
    if not runtime_root.is_dir() or runtime_root.resolve() != runtime_root.absolute():
        return
    timeout = connection.execute("PRAGMA busy_timeout").fetchone()[0]
    connection.execute("PRAGMA busy_timeout=0")
    try:
        connection.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        if exc.sqlite_errorcode in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
            return
        raise
    finally:
        connection.execute(f"PRAGMA busy_timeout={timeout}")
    try:
        rows = connection.execute(
            """
            SELECT e.id, COALESCE(s.parent_session_id,s.id)
            FROM executions e JOIN sessions s ON s.id=e.session_id
            WHERE e.state IN ('exited','failed','cancelled')
            AND unixepoch(COALESCE(e.exited_at,e.created_at)) < ?
            """, (cutoff,)
        ).fetchall()
        idle_roots = {}
        for execution_id, parent_id in rows:
            # Stored IDs normally are UUIDs; do not trust them as path components.
            if any(Path(value).name != value or value in {".", ".."}
                   for value in (execution_id, parent_id)):
                continue
            protected = connection.execute(
                """
                SELECT 1 FROM sessions s
                WHERE COALESCE(s.parent_session_id,s.id)=?
                AND (
                    unixepoch(s.created_at) >= ?
                    OR EXISTS (SELECT 1 FROM executions e WHERE e.session_id=s.id
                        AND (e.state IN ('prepared','starting','running','uncertain')
                             OR unixepoch(COALESCE(e.exited_at,e.created_at)) >= ?))
                    OR EXISTS (SELECT 1 FROM requests r WHERE r.parent_session_id=s.id
                        AND (r.state IN ('launching','pending','uncertain')
                             OR r.acknowledged_at IS NULL
                             OR unixepoch(MAX(r.created_at,COALESCE(r.completed_at,r.created_at),
                                 COALESCE(r.acknowledged_at,r.created_at),
                                 COALESCE(r.claimed_at,r.created_at))) >= ?))
                ) LIMIT 1
                """, (parent_id, cutoff, cutoff, cutoff)
            ).fetchone()
            if protected:
                continue
            root = runtime_root / parent_id
            execution = root / "executions" / execution_id
            try:
                if not execution.is_dir() or root.resolve() != root.absolute():
                    continue
                if root not in idle_roots:
                    paths = [root, *root.rglob("*")]
                    inbox = root / "inbox"
                    idle_roots[root] = not any(
                        path.is_symlink() or path.resolve() != path.absolute()
                        or path.stat().st_mtime >= cutoff for path in paths
                    ) and not (inbox.exists() and any(inbox.iterdir()))
                if not idle_roots[root]:
                    continue
                # Resolve and verify the exact deletion target, including every
                # parent, before recursive removal (also rejects junctions).
                if execution.resolve() != execution.absolute():
                    continue
                shutil.rmtree(execution)
                if not any(execution.parent.iterdir()):
                    execution.parent.rmdir()
            except OSError:
                # Busy logs, permissions, or concurrent filesystem writes must
                # never prevent a session from opening.
                continue
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
