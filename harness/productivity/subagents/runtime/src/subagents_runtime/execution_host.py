"""Public lifecycle boundary for independently implemented execution hosts.

Hosts report process facts here rather than reading or updating runtime tables.
Reply delivery and execution ownership remain runtime responsibilities.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from subagents_runtime.storage import connect


@dataclass(frozen=True)
class Reservation:
    session_id: str
    execution_id: str
    parent_session_id: str
    conversation_id: str | None
    fork_of: str | None
    previous_agent_id: str | None


def reservation(request_id: str) -> Reservation:
    from subagents_runtime.sessions import SessionError
    with connect() as db:
        row = db.execute(
            "SELECT r.child_session_id,e.id,r.parent_session_id,s.provider_session_id,e.fork_of FROM requests r JOIN executions e ON e.request_id=r.id JOIN sessions s ON s.id=r.child_session_id WHERE r.id=?",
            (request_id,),
        ).fetchone()
        if not row:
            raise SessionError("Delegated launch requires a persisted execution reservation")
        previous = db.execute(
            "SELECT backend_agent_id FROM executions WHERE session_id=? AND backend_agent_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
            (row[0],),
        ).fetchone()
    return Reservation(*row, previous[0] if previous else None)


def starting(execution_id: str, backend: str, *, fork: bool = False) -> None:
    from subagents_runtime.sessions import SessionError
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        changed = db.execute("UPDATE executions SET state='starting',backend=? WHERE id=? AND state='prepared'", (backend, execution_id))
        if changed.rowcount != 1:
            raise SessionError("Execution was already started or is uncertain")
        if fork:
            db.execute("UPDATE sessions SET provider_session_id=NULL WHERE id=(SELECT session_id FROM executions WHERE id=?)", (execution_id,))


def bind(execution_id: str, conversation_id: str, agent_id: str | None, handle: str | None) -> None:
    from subagents_runtime.processes import confirm_startup
    with connect() as db:
        db.execute("UPDATE executions SET backend_agent_id=?,backend_handle=? WHERE id=?", (agent_id, handle, execution_id))
        db.execute("UPDATE sessions SET provider_session_id=? WHERE id=(SELECT session_id FROM executions WHERE id=?)", (conversation_id, execution_id))
    confirm_startup(execution_id)


def rejected(execution_id: str) -> None:
    """Only a proven pre-launch refusal may release the launch intent."""
    with connect() as db:
        db.execute("UPDATE executions SET state='prepared' WHERE id=? AND state='starting' AND host_claim IS NULL", (execution_id,))


def started(execution_id: str, provider_pid: int, supervisor_pid: int | None = None) -> None:
    from subagents_runtime.processes import birth_identity
    supervisor_pid = supervisor_pid or os.getpid()
    with connect() as db:
        db.execute(
            "UPDATE executions SET supervisor_pid=?,supervisor_birth=?,provider_pid=?,provider_birth=? WHERE id=?",
            (supervisor_pid, birth_identity(supervisor_pid), provider_pid, birth_identity(provider_pid), execution_id),
        )


def exited(execution_id: str, exit_code: int, *, provider_alive: bool, spawn_error: str | None,
           result: str = "", success: bool = False, cancelled: bool = False,
           already_reported: bool = False) -> None:
    from subagents_runtime.delegation import report_child_stop
    state = "uncertain" if provider_alive else "failed" if spawn_error else "exited"
    with connect() as db:
        db.execute(
            "UPDATE executions SET state=?,exit_code=?,exited_at=CASE WHEN ?='uncertain' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id=?",
            (state, exit_code, state, execution_id),
        )
        session = db.execute("SELECT session_id FROM executions WHERE id=?", (execution_id,)).fetchone()
    if session and not provider_alive and not already_reported:
        report_child_stop(
            session[0], result, success=success,
            reason=None if success else spawn_error or "Provider process exited without delivering a result",
            cancelled=cancelled, execution_id=execution_id,
        )
