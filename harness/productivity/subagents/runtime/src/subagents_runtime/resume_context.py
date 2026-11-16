"""Atomic public resume authority for execution hosts, independent of local locks."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from subagents_runtime.sessions import SessionError
from subagents_runtime.storage import connect


def verified_provider(pid: int | None, birth: str | None) -> bool:
    from subagents_runtime.processes import birth_identity, process_alive
    return bool(pid and birth and process_alive(pid) and birth_identity(pid) == birth)


def resume_context(request: dict) -> dict:
    claim = request.get("hostClaim")
    if not isinstance(claim, str) or not claim.strip():
        raise SessionError("Resume requires an execution host claim")
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT s.id,s.parent_session_id,s.provider,s.execution_mode,s.cwd,"
            "COALESCE(e.fork_of,s.provider_session_id),e.id,e.state,e.fork_of,r.task,e.host_claim "
            "FROM requests r JOIN executions e ON e.request_id=r.id "
            "JOIN sessions s ON s.id=r.child_session_id "
            "WHERE r.id=? AND r.kind='resume' AND e.backend='bridge' AND e.superseded_at IS NULL "
            "AND r.state='launching'",
            (request.get("requestId"),),
        ).fetchone()
        if not row or row[7] != "starting":
            raise SessionError("Resume reservation is unavailable or not awaiting launch")
        if row[10] is not None:
            raise SessionError("Resume reservation was already claimed; execution is uncertain")
        expected = dict(zip(
            ("harnessSessionId", "parentSessionId", "provider", "mode", "cwd", "resumeSessionId", "executionId"),
            row[:7],
        ))
        for key, value in expected.items():
            actual = request.get(key)
            if key == "cwd":
                if not isinstance(actual, str) or Path(actual).resolve() != Path(value).resolve():
                    raise SessionError("Resume launch root does not match the durable child")
            elif actual != value:
                raise SessionError("Resume ownership or execution identity does not match")
        if request.get("forkSessionId") != row[8]:
            raise SessionError("Resume fork identity does not match")
        previous = db.execute(
            "SELECT state,backend_agent_id,backend_handle,provider_pid,provider_birth,backend "
            "FROM executions WHERE session_id=? AND id<>? ORDER BY rowid DESC", (row[0], row[6]),
        ).fetchall()
        if not previous:
            raise SessionError("Previous delegated execution ownership is unavailable; resume refused")
        action = "fork" if row[8] else "reopen"
        if not row[8] and any(state not in {"exited", "failed", "cancelled"} for state, *_ in previous):
            state, agent, terminal, pid, birth, backend = previous[0]
            if (row[3] != "loop" or state != "running" or backend != "bridge"
                    or not agent or not terminal or agent != request.get("localAgentId")
                    or terminal != request.get("localTerminalId") or not verified_provider(pid, birth)):
                raise SessionError("Previous delegated execution is running or uncertain; resume refused")
            if any(
                earlier_state not in {"exited", "failed", "cancelled"}
                and (earlier_state, earlier_agent, earlier_terminal, earlier_pid, earlier_birth, earlier_backend)
                != (state, agent, terminal, pid, birth, backend)
                for earlier_state, earlier_agent, earlier_terminal, earlier_pid, earlier_birth, earlier_backend in previous
            ):
                raise SessionError("Another delegated execution is running or uncertain; resume refused")
            action = "reuse-terminal"
        db.execute("UPDATE executions SET host_claim=? WHERE id=?", (claim, row[6]))
    return {"task": row[9], "cwd": row[4], "action": action}


def session_context(session_id: str) -> dict:
    """Resolve durable navigation facts without claiming or launching an execution."""
    with connect() as db:
        row = db.execute("SELECT provider_session_id,parent_session_id FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise SessionError("Unknown Harness session")
    return {"providerSessionId": row[0], "parentSessionId": row[1]}


if __name__ == "__main__":
    try:
        result = session_context(sys.argv[2]) if sys.argv[1] == "--session" else resume_context(json.loads(sys.argv[1]))
        print(json.dumps(result))
    except (SessionError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
