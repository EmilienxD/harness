"""Bind reply ownership before an execution host submits terminal input."""

from __future__ import annotations

import sys

from subagents_runtime.sessions import SessionError
from subagents_runtime.storage import connect


def prepare_terminal_resume(session_id: str, execution_id: str, agent_id: str,
                            terminal_id: str, conversation_id: str) -> None:
    from subagents_runtime.backends import supports_live_continuation
    from subagents_runtime.resume_context import verified_provider
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT e.state,e.input_execution_id,s.execution_mode,e.backend,COALESCE(e.fork_of,s.provider_session_id),e.backend_agent_id,e.backend_handle,e.provider_pid,e.provider_birth FROM executions e JOIN sessions s ON s.id=e.session_id WHERE e.id=? AND e.session_id=? AND e.superseded_at IS NULL",
            (execution_id, session_id),
        ).fetchone()
        if not current or current[2] not in {"interactive", "loop"} or not supports_live_continuation(current[3]):
            raise SessionError("Terminal continuation identity or mode does not match")
        if current[4] != conversation_id:
            raise SessionError("Terminal continuation native conversation does not match")
        if current[0] == "running" and current[1]:
            if current[5:7] != (agent_id, terminal_id) or not verified_provider(current[7], current[8]):
                raise SessionError("Existing terminal execution ownership or live provider identity is unavailable")
            return
        if current[0] != "starting":
            raise SessionError("Terminal continuation is not awaiting delivery")
        previous = connection.execute(
            "SELECT COALESCE(input_execution_id,id),provider_pid,provider_birth,supervisor_pid,supervisor_birth FROM executions WHERE session_id=? AND backend_agent_id=? AND backend_handle=? AND state='running' AND superseded_at IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            (session_id, agent_id, terminal_id),
        ).fetchone()
        if not previous or not verified_provider(previous[1], previous[2]):
            raise SessionError("Existing terminal execution ownership or live provider identity is unavailable")
        if current[2] == "interactive":
            from subagents_runtime.storage import state_dir

            ready = state_dir() / "runtime/reply-ready" / previous[0]
            if not ready.is_file():
                raise SessionError("Existing terminal has no verified reply support; reopen it before continuing")
            from subagents_runtime.reply_support import _write

            _write(ready.parent / execution_id, ready.read_bytes())
        connection.execute(
            "UPDATE executions SET input_execution_id=?,provider_pid=?,provider_birth=?,supervisor_pid=?,supervisor_birth=?,backend_agent_id=?,backend_handle=?,fork_of=NULL,state='running',started_at=CURRENT_TIMESTAMP WHERE id=?",
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
