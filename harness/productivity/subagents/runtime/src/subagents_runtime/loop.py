"""Launch and inspect the Lead's visible loop implementer."""

from __future__ import annotations

import json
import os
from pathlib import Path
import uuid
import time
from dataclasses import asdict

import yaml

from subagents_runtime import sessions
from subagents_runtime import context_usage, processes
from subagents_runtime.delegation import enable_delegation, process_inbox
from subagents_runtime.storage import connect


def worktree_key(cwd: Path) -> str:
    return os.path.normcase(str(cwd.resolve()))


def _configuration(cwd):
    config = sessions.launch_configuration(cwd)
    if config.get("session", {}).get("stopWaitHours", 24) > 24:
        raise sessions.SessionError("loop session.stopWaitHours cannot exceed the installed 24-hour Stop-hook wait budget")
    return config


def lookup(identifier: str, *, parent_id: str | None = None) -> dict:
    session_id = sessions.resolve_session(identifier, parent_id)
    with connect() as db:
        expired = db.execute("SELECT 1 FROM loop_sessions l JOIN loop_waits w ON w.session_id=l.session_id "
                             "WHERE l.session_id=? AND l.active=1 AND w.state='expired'", (session_id,)).fetchone()
    if expired:
        processes.live_executions(session_id)
    with connect() as db:
        cursor = db.execute(
            "SELECT s.id AS session_id,s.provider_session_id,s.parent_session_id,s.agent_index,"
            "s.cwd,s.provider,s.execution_mode,l.active,l.prompt_path,l.difficulty,l.context_usage,l.released_at "
            "FROM sessions s JOIN loop_sessions l ON l.session_id=s.id WHERE s.id=?",
            (session_id,),
        )
        row = cursor.fetchone()
        if row is None:
            raise sessions.SessionError(f"unknown loop implementer {identifier}")
        result = dict(zip((field[0] for field in cursor.description), row))
        wait = db.execute("SELECT token,state,deadline FROM loop_waits WHERE session_id=?", (session_id,)).fetchone()
        result["wait"] = dict(zip(("token", "state", "deadline"), wait)) if wait else {}
        result["last_report"] = None
        for (reply,) in db.execute("SELECT reply FROM requests WHERE child_session_id=? AND mode='loop' AND reply IS NOT NULL ORDER BY rowid DESC", (session_id,)):
            report = json.loads(reply)
            if report.get("event") == "report":
                result["last_report"] = report
                break
    result["active"] = bool(result["active"])
    result["context_usage"] = json.loads(result["context_usage"]) if result["context_usage"] else None
    return result


def launch(parent_id: str, cwd: Path, prompt_path: Path, *, difficulty: str | None = None) -> dict:
    cwd, prompt_path = cwd.resolve(), prompt_path.resolve()
    if not cwd.is_dir():
        raise sessions.SessionError("loop cwd must be an existing initialized worktree")
    try:
        if not prompt_path.read_text(encoding="utf-8").strip():
            raise sessions.SessionError("loop prompt file must be nonempty")
    except OSError as exc:
        raise sessions.SessionError(f"cannot read loop prompt file: {exc}") from exc
    config = _configuration(cwd)
    inbox = enable_delegation(parent_id, "ship").inbox
    with connect() as db:
        provider = db.execute("SELECT provider FROM sessions WHERE id=?", (parent_id,)).fetchone()[0]
    sessions.delegation_profile_arguments(config, provider, "loop", difficulty=difficulty)
    metadata = {"task": "loop", "mode": "loop", "cwd": str(cwd), "prompt-file": str(prompt_path)}
    if difficulty is not None:
        metadata["difficulty"] = difficulty
    source = inbox / (uuid.uuid4().hex + ".md")
    source.write_text(
        "---\n" + yaml.safe_dump(metadata, sort_keys=False) + "---\n"
        + f"Read and follow the implementer instructions in {json.dumps(str(prompt_path))}.\n",
        encoding="utf-8",
    )
    results = process_inbox(parent_id, launch=sessions.launch_delegated, request_paths={source})
    result = next((result for result in results if result.path == source), None)
    if result is None or result.status != "launched":
        raise sessions.SessionError(result.reason if result else "loop launch was not processed")
    return lookup(result.child_session_id)


def is_implementer(session_id: str) -> bool:
    with connect() as db:
        return db.execute("SELECT 1 FROM loop_sessions WHERE session_id=? AND active=1", (session_id,)).fetchone() is not None


def resume(identifier, message, *, parent_id=None):
    info = lookup(identifier, parent_id=parent_id)
    _configuration(Path(info["cwd"]))
    caller = parent_id or os.environ.get("HARNESS_SESSION_ID")
    if info["active"]:
        raise sessions.SessionError("active implementers continue through exact-token feedback")
    if not message.strip():
        raise sessions.SessionError("resume requires a nonempty message")
    if caller and caller != info["parent_session_id"]:
        _adopt(info, caller)
        info = lookup(info["session_id"])
    inbox = enable_delegation(info["parent_session_id"], "ship").inbox
    source = inbox / (uuid.uuid4().hex + ".md")
    source.write_text(f'---\nresume: agent-{info["agent_index"]}\n---\n{message}', encoding="utf-8")
    results = process_inbox(info["parent_session_id"], launch=sessions.launch_delegated,
                            request_paths={source}, allow_loop_resume=True)
    result = next((item for item in results if item.path == source), None)
    if result is None or result.status != "launched":
        raise sessions.SessionError(result.reason if result else "loop resume was not processed")
    return lookup(info["session_id"])


def _adopt(info, lead):
    """A later /ship <PR> conversation takes over a released implementer and its future reports."""
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT provider FROM sessions WHERE id=?", (lead,)).fetchone()
        if row is None or row[0] != info["provider"]:
            raise sessions.SessionError("a new Lead can only resume an implementer of its own provider")
        if db.execute("SELECT 1 FROM loop_sessions WHERE session_id=? AND active=0", (info["session_id"],)).fetchone() is None:
            raise sessions.SessionError("only a released implementer can change Lead")
        # Children are addressed as agent-i within their parent, so take the next free index.
        index = db.execute(
            "SELECT MAX(n)+1 FROM (SELECT COALESCE(MAX(agent_index),0) n FROM sessions WHERE parent_session_id=? "
            "UNION ALL SELECT COALESCE(MAX(agent_number),0) FROM requests WHERE parent_session_id=?)", (lead, lead),
        ).fetchone()[0]
        # Delivery sequences belong to each Lead: retire what the old Lead never
        # acknowledged, then move the history with its (child, parent) references.
        db.execute("PRAGMA defer_foreign_keys=ON")
        db.execute("UPDATE requests SET acknowledgement_sequence=COALESCE(claim_sequence,0) WHERE child_session_id=? "
                   "AND state IN ('succeeded','failed','cancelled') AND acknowledgement_sequence IS NULL", (info["session_id"],))
        db.execute("UPDATE sessions SET parent_session_id=?,agent_index=? WHERE id=?", (lead, index, info["session_id"]))
        db.execute("UPDATE requests SET parent_session_id=?,agent_number=? WHERE child_session_id=?", (lead, index, info["session_id"]))


def _request(db, session_id):
    row = db.execute("SELECT id FROM requests WHERE child_session_id=? AND state IN ('launching','pending','uncertain')", (session_id,)).fetchone()
    if row:
        return row[0]
    identifier = uuid.uuid4().hex
    db.execute(
        "INSERT INTO requests(id,kind,parent_session_id,child_session_id,agent_number,task,provider,mode,state) "
        "SELECT ?,'resume',parent_session_id,id,agent_index,'loop',provider,'loop','pending' FROM sessions WHERE id=?",
        (identifier, session_id),
    )
    return identifier


def _notify(db, session_id, report):
    request = _request(db, session_id)
    db.execute("UPDATE requests SET state='succeeded',reply=?,delivery_id=?,completed_at=CURRENT_TIMESTAMP WHERE id=?",
               (json.dumps(report), uuid.uuid4().hex, request))


def _pause(db, session_id, reason):
    changed = db.execute("UPDATE loop_waits SET state='taken-over',feedback=NULL WHERE session_id=? AND state IN ('waiting','feedback')", (session_id,))
    if changed.rowcount:
        _notify(db, session_id, {"event": "takeover", "session_id": session_id, "reason": reason,
                                 "action": "Discard the previous verdict; wait for the next successful Stop."})
    _request(db, session_id)


def observe_event(session_id, event, prompt=None):
    """Record user steering and invalidate verdicts when the user takes over."""
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        children = db.execute("SELECT l.session_id FROM loop_sessions l JOIN sessions s ON s.id=l.session_id WHERE l.active=1 AND (s.id=? OR s.parent_session_id=?)", (session_id, session_id)).fetchall()
        for (child,) in children:
            if db.execute("SELECT 1 FROM loop_waits WHERE session_id=? AND state='expired'", (child,)).fetchone():
                continue
            if event == "UserPromptSubmit" and isinstance(prompt, str):
                db.execute("INSERT INTO loop_messages(session_id,source,message) VALUES (?,?,?)", (child, session_id, prompt))
            if child == session_id and event in {"UserPromptSubmit", "Interrupt", "StopFailure", "SessionEnd"}:
                _pause(db, child, event)


def _live(row):
    pid, birth, heartbeat, deadline = row
    if time.time() >= deadline or time.time() - heartbeat > 10:
        return False
    return processes.process_alive(pid) and (birth is None or processes.birth_identity(pid) == birth)


def respond(identifier, token, *, feedback=None, parent_id=None):
    """Address exactly one live Stop hook, never a future provider turn."""
    info = lookup(identifier, parent_id=parent_id)
    error = None
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT token,state,pid,birth,heartbeat,deadline FROM loop_waits WHERE session_id=?", (info["session_id"],)).fetchone()
        if not row or row[0] != token or row[1] != "waiting":
            error = "stale loop wait; discard the verdict and wait for the next Stop"
        elif not _live(row[2:]):
            _pause(db, info["session_id"], "waiting hook no longer exists")
            error = "user took over or waiting hook ended; discard the verdict"
        else:
            db.execute("UPDATE loop_waits SET state=?,feedback=? WHERE session_id=?", ("feedback" if feedback is not None else "released", feedback, info["session_id"]))
            if feedback is None:
                db.execute("UPDATE loop_sessions SET active=0,released_at=CURRENT_TIMESTAMP WHERE session_id=?", (info["session_id"],))
            else:
                _request(db, info["session_id"])
    if error:
        raise sessions.SessionError(error)
    return lookup(info["session_id"])


def report_and_wait(session_id, message, transcript_path, provider, *, timeout_seconds, poll_seconds=.1):
    measurement = None
    try:
        usage = context_usage.read_context_usage(transcript_path, provider) if transcript_path else None
        if usage is not None and usage.used_percentage is not None:
            measurement = {**asdict(usage), "used_percentage": usage.used_percentage}
    except Exception:
        # Telemetry must never prevent a successful report from reaching the Lead.
        pass
    token = uuid.uuid4().hex
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM loop_waits WHERE session_id=? AND state='expired'", (session_id,)).fetchone():
            _release(db, session_id)
            return None
        messages = [{"source": source, "message": text} for source, text in db.execute("SELECT source,message FROM loop_messages WHERE session_id=? ORDER BY id", (session_id,))]
        db.execute("DELETE FROM loop_messages WHERE session_id=?", (session_id,))
        db.execute("UPDATE loop_sessions SET context_usage=? WHERE session_id=?", (json.dumps(measurement) if measurement else None, session_id))
        db.execute("INSERT OR REPLACE INTO loop_waits(session_id,token,state,pid,birth,heartbeat,deadline) VALUES (?,?,'waiting',?,?,?,?)", (session_id, token, os.getpid(), processes.birth_identity(os.getpid()), time.time(), time.time() + timeout_seconds))
        _notify(db, session_id, {"event": "report", "session_id": session_id, "wait_token": token, "report": message, "context_usage": measurement, "user_messages": messages})
    try:
        while True:
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT token,state,feedback,deadline FROM loop_waits WHERE session_id=?", (session_id,)).fetchone()
                if row[1] == "expired":
                    _release(db, session_id)
                    return None
                if row[0] != token or row[1] not in {"waiting", "feedback"}:
                    return None
                if row[1] == "feedback":
                    db.execute("UPDATE loop_waits SET state='continued' WHERE session_id=?", (session_id,))
                    return row[2]
                if time.time() >= row[3]:
                    _expire(db, session_id, idle=True)
                    return None
                db.execute("UPDATE loop_waits SET heartbeat=? WHERE session_id=?", (time.time(), session_id))
            time.sleep(poll_seconds)
    finally:
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT token,state FROM loop_waits WHERE session_id=?", (session_id,)).fetchone()
            if row == (token, "waiting") or row == (token, "feedback"):
                _pause(db, session_id, "waiting hook interrupted")


def _release(db, session_id):
    db.execute("UPDATE loop_sessions SET active=0,released_at=CURRENT_TIMESTAMP WHERE session_id=?", (session_id,))


def release_expired_after_exit(session_id):
    """Free a timed-out reservation only when no execution can still work."""
    with connect() as db:
        db.execute("UPDATE loop_sessions SET active=0,released_at=CURRENT_TIMESTAMP "
                   "WHERE session_id=? AND active=1 "
                   "AND EXISTS (SELECT 1 FROM loop_waits WHERE session_id=? AND state='expired') "
                   "AND NOT EXISTS (SELECT 1 FROM executions WHERE session_id=? AND superseded_at IS NULL "
                   "AND state IN ('prepared','starting','running','uncertain'))",
                   (session_id, session_id, session_id))


def reconcile_worktree(cwd):
    with connect() as db:
        rows = db.execute("SELECT l.session_id FROM loop_sessions l JOIN loop_waits w ON w.session_id=l.session_id "
                          "WHERE l.worktree_key=? AND l.active=1 AND w.state='expired'", (worktree_key(cwd),)).fetchall()
    for (session_id,) in rows:
        processes.live_executions(session_id)


def _expire(db, session_id, *, idle=False):
    if db.execute("SELECT 1 FROM loop_waits WHERE session_id=? AND state='expired'", (session_id,)).fetchone():
        return
    # A parent may time out while the child is working, before any Stop wait
    # exists. Persist a terminal marker without freeing its worktree yet.
    db.execute("INSERT INTO loop_waits(session_id,token,state,pid,heartbeat,deadline) VALUES (?,?,'expired',0,?,?) "
               "ON CONFLICT(session_id) DO UPDATE SET state='expired',feedback=NULL",
               (session_id, uuid.uuid4().hex, time.time(), time.time()))
    _notify(db, session_id, {"event": "wait-expired", "session_id": session_id,
                            "action": "End with [AI]-needs-decision, a draft PR, and a precise issue comment."})
    if idle:
        _release(db, session_id)


def expire_parent_wait(parent_id):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("SELECT l.session_id FROM loop_sessions l JOIN sessions s ON s.id=l.session_id WHERE s.parent_session_id=? AND l.active=1", (parent_id,)).fetchall()
        for (session_id,) in rows:
            _expire(db, session_id)
