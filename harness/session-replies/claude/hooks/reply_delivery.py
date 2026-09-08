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


def ready(connection: sqlite3.Connection, parent: str, include_claimed: bool = False):
    return connection.execute(
        f"""
        SELECT id, delivery_id, reply FROM requests
        WHERE parent_session_id = ? AND state = 'replied'
          AND acknowledged_at IS NULL
          {'' if include_claimed else 'AND claimed_at IS NULL'}
        ORDER BY created_at
        """,
        (parent,),
    ).fetchall()


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
    connection = sqlite3.connect(database_path(), timeout=30, isolation_level=None)
    try:
        connection.execute("BEGIN IMMEDIATE")
        # A later non-prompt boundary acknowledges an earlier injection. Prompt
        # hooks are the restart fallback: they deliberately redeliver an
        # unacknowledged claim with the same stable delivery ID.
        if mode != "prompt":
            connection.execute(
                "UPDATE requests SET acknowledged_at = CURRENT_TIMESTAMP "
                "WHERE parent_session_id = ? AND claimed_at IS NOT NULL "
                "AND acknowledged_at IS NULL "
                "AND claimed_at < datetime('now', '-2 seconds')",
                (parent,),
            )
        connection.commit()

        rows = ready(connection, parent, include_claimed=mode == "prompt")
        if mode == "stop" and not rows:
            pending = connection.execute(
                "SELECT 1 FROM requests WHERE parent_session_id = ? AND state = 'pending' LIMIT 1",
                (parent,),
            ).fetchone()
            while pending and not rows:
                time.sleep(0.25)
                rows = ready(connection, parent)
                pending = connection.execute(
                    "SELECT 1 FROM requests WHERE parent_session_id = ? AND state = 'pending' LIMIT 1",
                    (parent,),
                ).fetchone()
        if not rows:
            return 0

        connection.execute("BEGIN IMMEDIATE")
        claimed = []
        for request_id, delivery_id, message in rows:
            changed = connection.execute(
                "UPDATE requests SET claimed_at = CURRENT_TIMESTAMP "
                "WHERE id = ? AND acknowledged_at IS NULL",
                (request_id,),
            )
            if changed.rowcount:
                claimed.append((delivery_id, message))
        connection.commit()
        if not claimed:
            return 0
        context = "\n\n".join(
            f"<harness-reply delivery-id=\"{delivery_id}\">\n{message}\n</harness-reply>"
            for delivery_id, message in claimed
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
