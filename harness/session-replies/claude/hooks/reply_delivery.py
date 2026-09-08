"""Deliver durable Harness child replies into their parent Claude session."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path


def database_path() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".harness"
    return root / "sessions.sqlite3"


VALID_MODES = {"post-tool", "stop", "prompt"}


def claim_ready(connection: sqlite3.Connection, parent: str, mode: str):
    """Atomically claim one instant's replies, or redeliver claims on fallback."""
    connection.execute("BEGIN IMMEDIATE")
    try:
        if mode != "prompt":
            # A near-simultaneous competing hook must not acknowledge the winner
            # before Claude has consumed its output. A later boundary does.
            connection.execute(
                "UPDATE requests SET acknowledged_at = CURRENT_TIMESTAMP "
                "WHERE parent_session_id = ? AND claimed_at IS NOT NULL "
                "AND acknowledged_at IS NULL "
                "AND claimed_at < datetime('now', '-2 seconds')",
                (parent,),
            )
        claimed_filter = "" if mode == "prompt" else "AND claimed_at IS NULL"
        rows = connection.execute(
            f"""
            SELECT id, delivery_id, reply FROM requests
            WHERE parent_session_id = ? AND state = 'replied'
              AND acknowledged_at IS NULL {claimed_filter}
            ORDER BY created_at, id
            """,
            (parent,),
        ).fetchall()
        if mode == "prompt":
            for request_id, _delivery_id, _message in rows:
                connection.execute(
                    "UPDATE requests SET claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP) WHERE id = ?",
                    (request_id,),
                )
        else:
            won = []
            for row in rows:
                changed = connection.execute(
                    "UPDATE requests SET claimed_at = CURRENT_TIMESTAMP "
                    "WHERE id = ? AND claimed_at IS NULL AND acknowledged_at IS NULL",
                    (row[0],),
                )
                if changed.rowcount:
                    won.append(row)
            rows = won
        connection.commit()
        return rows
    except BaseException:
        connection.rollback()
        raise


def has_pending(connection: sqlite3.Connection, parent: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM requests WHERE parent_session_id = ? AND state = 'pending' LIMIT 1",
        (parent,),
    ).fetchone() is not None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    parent = payload.get("session_id")
    event = payload.get("hook_event_name")
    if not isinstance(parent, str) or not database_path().is_file():
        return 0
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in VALID_MODES:
        return 0
    connection = sqlite3.connect(database_path(), timeout=30, isolation_level=None)
    try:
        rows = claim_ready(connection, parent, mode)
        if mode == "stop":
            while not rows and has_pending(connection, parent):
                time.sleep(0.25)
                rows = claim_ready(connection, parent, mode)
        if not rows:
            return 0
        context = "\n\n".join(
            f"<harness-reply delivery-id=\"{delivery_id}\">\n{message}\n</harness-reply>"
            for _request_id, delivery_id, message in rows
        )
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": context,
            }
        }))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
