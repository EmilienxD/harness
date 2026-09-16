"""Versioned, transactional storage for saved conversations and executions."""

from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path

SCHEMA_VERSION = 2


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    return (
        Path(configured).expanduser().resolve()
        if configured
        else Path.home() / ".harness"
    )


class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def _rows(connection, table):
    if not connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone():
        return []
    cursor = connection.execute(f"SELECT * FROM {table}")
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def _insert(connection, table, row):
    columns = {
        column[1] for column in connection.execute(f"PRAGMA table_info({table})")
    }
    values = {key: value for key, value in row.items() if key in columns}
    connection.execute(
        f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
        tuple(values.values()),
    )


def _migrate(connection):
    connection.execute("PRAGMA foreign_keys=OFF")
    connection.execute("BEGIN IMMEDIATE")
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= SCHEMA_VERSION:
            connection.commit()
            return
        if version == 1:
            # Rebuild only executions, preserving all identities and lifecycle state.
            connection.execute("DROP INDEX executions_session_active")
            connection.execute("ALTER TABLE executions RENAME TO executions_v1")
            schema = (Path(__file__).parent / "resources" / "schema.sql").read_text(encoding="utf-8")
            for statement in schema.split(";"):
                if statement.strip().startswith(("CREATE TABLE executions (", "CREATE UNIQUE INDEX executions_session_active")):
                    connection.execute(statement)
            connection.execute("INSERT INTO executions SELECT * FROM executions_v1")
            connection.execute("DROP TABLE executions_v1")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise sqlite3.IntegrityError("Invalid execution/request ownership")
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.commit()
            return
        saved = {
            table: _rows(connection, table)
            for table in ("sessions", "requests", "grants", "reply_authorizations")
        }
        for table in ("reply_authorizations", "requests", "grants", "sessions"):
            connection.execute(f"DROP TABLE IF EXISTS {table}")
        for statement in (
            (Path(__file__).parent / "resources" / "schema.sql")
            .read_text(encoding="utf-8")
            .split(";")
        ):
            if statement.strip():
                connection.execute(statement)
        children = {
            row["child_session_id"]: row
            for row in saved["requests"]
            if row.get("child_session_id")
        }
        for row in saved["sessions"]:
            row["provider_session_id"] = row.pop(
                "claude_session_id", row.get("provider_session_id")
            )
            if row["id"] in children:
                request = children[row["id"]]
                row.setdefault("execution_mode", request.get("mode") or "interactive")
                row.setdefault("provider", request.get("provider") or "claude")
                row["parent_session_id"] = request["parent_session_id"]
                row["agent_index"] = request.get("agent_number") or 1 + sum(
                    1
                    for other in children.values()
                    if other["parent_session_id"] == request["parent_session_id"]
                    and other["id"] < request["id"]
                )
            _insert(connection, "sessions", row)
        used_sources = set()
        for row in saved["requests"]:
            key = (row["parent_session_id"], row.get("source_name"))
            if row.get("source_name") and key in used_sources:
                row["source_name"] = (
                    str(row.get("grant_id") or row["id"]) + "-" + row["source_name"]
                )
            used_sources.add((row["parent_session_id"], row.get("source_name")))
            if row["state"] == "replied":
                row["state"] = "succeeded"
            child = children.get(row.get("child_session_id"))
            if child:
                row["agent_number"] = connection.execute(
                    "SELECT agent_index FROM sessions WHERE id=?",
                    (row["child_session_id"],),
                ).fetchone()[0]
            if row.get("claimed_at") and row.get("claim_sequence") is None:
                row["claim_sequence"] = 0
            if (
                row.get("acknowledged_at")
                and row.get("acknowledgement_sequence") is None
            ):
                row["acknowledgement_sequence"] = 1
            _insert(connection, "requests", row)
            if row.get("child_session_id"):
                _insert(
                    connection,
                    "executions",
                    {
                        "id": uuid.uuid4().hex,
                        "session_id": row["child_session_id"],
                        "request_id": row["id"],
                        "backend": "legacy",
                        "state": "uncertain",
                    },
                )
        for row in saved["reply_authorizations"]:
            _insert(connection, "reply_authorizations", row)
        for grant in saved["grants"]:
            inbox = (
                state_dir()
                / "runtime"
                / "sessions"
                / grant["parent_session_id"]
                / "inbox"
            )
            inbox.mkdir(parents=True, exist_ok=True)
            connection.execute(
                "INSERT OR IGNORE INTO session_delegation(parent_session_id,inbox,enabled_at) VALUES (?,?,COALESCE(?,CURRENT_TIMESTAMP))",
                (
                    grant["parent_session_id"],
                    str(inbox.resolve()),
                    grant.get("created_at"),
                ),
            )
            old = Path(grant["inbox"])
            if old.is_dir() and not old.is_symlink():
                for source in old.iterdir():
                    if source.is_file() and not source.is_symlink():
                        matching = next(
                            (
                                r
                                for r in saved["requests"]
                                if r.get("grant_id") == grant["id"]
                                and r.get("source_name")
                                in {
                                    source.name.removesuffix(".running").removesuffix(
                                        ".failed"
                                    ),
                                    grant["id"]
                                    + "-"
                                    + source.name.removesuffix(".running").removesuffix(
                                        ".failed"
                                    ),
                                }
                            ),
                            None,
                        )
                        name = matching["source_name"] if matching else source.name
                        target = inbox / name
                        if (
                            matching
                            and matching["state"] in {"launching", "pending"}
                            and not name.endswith(".running")
                        ):
                            target = inbox / (name + ".running")
                        if not matching:
                            target = inbox / (grant["id"] + "-" + source.name)
                        destination = (
                            None
                            if matching
                            and matching["state"]
                            in {"succeeded", "failed", "cancelled"}
                            else str(target)
                        )
                        connection.execute(
                            "INSERT INTO inbox_migrations(source,destination) VALUES (?,?)",
                            (str(source.absolute()), destination),
                        )
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise sqlite3.IntegrityError(
                f"Invalid legacy session relationships: {violations}"
            )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.execute("PRAGMA foreign_keys=ON")


def _reconcile_migration_files(connection):
    """Filesystem work follows the committed migration and is safely replayable."""
    if not connection.execute(
        "SELECT 1 FROM inbox_migrations WHERE reconciled_at IS NULL LIMIT 1"
    ).fetchone():
        return
    connection.execute("BEGIN IMMEDIATE")
    for source_value, destination_value in connection.execute(
        "SELECT source,destination FROM inbox_migrations WHERE reconciled_at IS NULL"
    ).fetchall():
        source = Path(source_value)
        if source.is_symlink():
            continue
        if source.exists():
            if destination_value is None:
                source.unlink()
            else:
                destination = Path(destination_value)
                if destination.exists():
                    # A previous recovery may have moved this exact file already.
                    if destination.read_bytes() != source.read_bytes():
                        raise sqlite3.IntegrityError(
                            "Conflicting legacy inbox files require reconciliation"
                        )
                    source.unlink()
                else:
                    source.replace(destination)
        connection.execute(
            "UPDATE inbox_migrations SET reconciled_at=CURRENT_TIMESTAMP WHERE source=?",
            (source_value,),
        )
    connection.commit()


def connect():
    root = state_dir()
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(
        root / "sessions.sqlite3", timeout=30, factory=Connection
    )
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    try:
        if version > SCHEMA_VERSION:
            raise sqlite3.DatabaseError(f"Unsupported session schema version {version}")
        if version < SCHEMA_VERSION:
            _migrate(connection)
        _reconcile_migration_files(connection)
    except BaseException:
        connection.close()
        raise
    return connection
