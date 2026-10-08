"""Bind a continuation before Aboard submits input to an existing provider TUI."""

from __future__ import annotations

import sys

from subagents_runtime.sessions import SessionError
from subagents_runtime.storage import connect


def prepare_terminal_resume(session_id: str, execution_id: str, agent_id: str,
                            terminal_id: str, conversation_id: str) -> None:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT e.state,e.input_execution_id,s.execution_mode FROM executions e JOIN sessions s ON s.id=e.session_id WHERE e.id=? AND e.session_id=? AND e.backend='aboard'",
            (execution_id, session_id),
        ).fetchone()
        if not current or current[2] not in {"interactive", "loop"}:
            raise SessionError("Terminal continuation identity or mode does not match")
        if current[0] == "running" and current[1]:
            return
        if current[0] != "starting":
            raise SessionError("Terminal continuation is not awaiting delivery")
        previous = connection.execute(
            "SELECT COALESCE(input_execution_id,id),provider_pid,provider_birth,supervisor_pid,supervisor_birth FROM executions WHERE session_id=? AND aboard_agent_id=? AND aboard_handle=? AND state='running' AND superseded_at IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            (session_id, agent_id, terminal_id),
        ).fetchone()
        if not previous:
            raise SessionError("Existing terminal execution ownership is unavailable")
        connection.execute(
            "UPDATE executions SET input_execution_id=?,provider_pid=?,provider_birth=?,supervisor_pid=?,supervisor_birth=?,aboard_agent_id=?,aboard_handle=?,fork_of=NULL,state='running',started_at=CURRENT_TIMESTAMP WHERE id=?",
            (*previous, agent_id, terminal_id, execution_id),
        )
        connection.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (conversation_id, session_id))
        connection.execute("UPDATE requests SET state='pending' WHERE id=(SELECT request_id FROM executions WHERE id=?)", (execution_id,))


if __name__ == "__main__":
    try:
        prepare_terminal_resume(*sys.argv[1:])
    except (SessionError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
