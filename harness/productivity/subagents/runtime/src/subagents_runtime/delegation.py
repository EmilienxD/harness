"""Persistent conversation inboxes, request claiming, and durable delivery."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

import yaml

from subagents_runtime.storage import new_inbox
from subagents_runtime.roles import RoleError, load_task_policies, task_policy

PROVIDERS = frozenset({"claude", "chatgpt"})
# Request frontmatter spells ChatGPT as "chatgpt" or "codex"; both normalize to
# the canonical provider name before validation, storage, and launch.
PROVIDER_ALIASES = {"codex": "chatgpt"}
SKILL_INVOCATION = re.compile(r"(?<!\S)[/\$][A-Za-z0-9_-]+(?=\s|$)")


def normalize_provider(provider: str) -> str:
    return PROVIDER_ALIASES.get(provider, provider)


class RequestFileError(ValueError):
    """A request file is unsafe, malformed, or outside its conversation inbox."""


@dataclass(frozen=True)
class DelegationRequest:
    path: Path
    task: str
    provider: str
    mode: str
    prompt: str
    resume: str | None = None
    cwd: Path | None = None
    difficulty: str | None = None
    prompt_path: Path | None = None
    child_skill: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class DelegationInbox:
    id: str
    parent_session_id: str
    provider: str
    original_cwd: Path
    inbox: Path


@dataclass(frozen=True)
class ProcessResult:
    path: Path
    status: str
    request_id: str | None = None
    child_session_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class ParentDelivery:
    delivery_id: str
    text: str


def _canonical_direct_child(path: Path, inbox: Path) -> tuple[Path, Path]:
    canonical_inbox = inbox.resolve(strict=True)
    if path.is_symlink():
        raise RequestFileError("request file must not be a symlink")
    try:
        canonical_path = path.resolve(strict=True)
    except OSError as exc:
        raise RequestFileError(f"request file is unavailable: {exc}") from exc
    if path.parent.resolve(strict=True) != canonical_inbox:
        try:
            canonical_path.relative_to(canonical_inbox)
        except ValueError as exc:
            raise RequestFileError(
                "request file is outside the canonical inbox"
            ) from exc
        raise RequestFileError(
            "request file must be a direct child of the canonical inbox"
        )
    if canonical_path.parent != canonical_inbox:
        raise RequestFileError("request file is outside the canonical inbox")
    return canonical_path, canonical_inbox


def parse_request_file(
    path: Path,
    inbox: Path,
    *,
    parent_provider: str,
    claimed: bool = False,
    cwd: Path | None = None,
) -> DelegationRequest:
    canonical_path, _ = _canonical_direct_child(path, inbox)
    if canonical_path.suffix.lower() != ".md" and not (
        claimed and canonical_path.name.endswith(".md.running")
    ):
        raise RequestFileError("request file must be Markdown (*.md)")
    try:
        raw = canonical_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RequestFileError(f"request file cannot be read as UTF-8: {exc}") from exc
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        raise RequestFileError("request file must start with YAML frontmatter")
    try:
        closing = next(
            index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"
        )
    except StopIteration as exc:
        raise RequestFileError("request file has unclosed YAML frontmatter") from exc
    try:
        metadata = yaml.safe_load("\n".join(lines[1:closing]))
    except yaml.YAMLError as exc:
        raise RequestFileError(f"invalid YAML frontmatter: {exc}") from exc
    if not isinstance(metadata, dict):
        raise RequestFileError("frontmatter must be a mapping")
    keys = set(metadata)
    accepted = {"task", "provider", "mode", "model", "resume", "cwd", "difficulty", "prompt-file"}
    if extras := keys - accepted:
        raise RequestFileError(
            "unsupported frontmatter keys: " + ", ".join(sorted(map(str, extras)))
        )
    prompt = "\n".join(lines[closing + 1 :]).strip()
    if not prompt:
        raise RequestFileError("request body must be nonempty")
    if "resume" in metadata:
        if (
            keys != {"resume"}
            or not isinstance(metadata["resume"], str)
            or not re.fullmatch(r"agent-[1-9][0-9]*", metadata["resume"])
        ):
            raise RequestFileError("resume requires only an agent-i identifier")
        return DelegationRequest(canonical_path, "", "", "", prompt, metadata["resume"])
    for key in ("task", "mode"):
        if key not in metadata:
            raise RequestFileError(f"frontmatter requires {key}")
    for key, value in metadata.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value.strip():
            raise RequestFileError(
                f"frontmatter {key!s} must be a nonempty scalar string"
            )
    task = metadata["task"].strip()
    mode = metadata["mode"].strip()
    provider = normalize_provider(metadata.get("provider", parent_provider).strip())
    try:
        policy = task_policy(task, cwd or Path.cwd(), parent_provider)
    except RoleError as exc:
        raise RequestFileError(str(exc)) from exc
    if policy is None:
        raise RequestFileError(f"unsupported task {task!r}")
    if mode not in policy.modes:
        raise RequestFileError(f"unsupported mode {mode!r} for task {task!r}")
    if provider not in PROVIDERS:
        raise RequestFileError(f"unsupported provider {provider!r}")
    if task != "loop" and keys & {"cwd", "difficulty", "prompt-file"}:
        raise RequestFileError("cwd, difficulty and prompt-file are only supported for loop requests")
    if task == "loop":
        if provider != parent_provider:
            raise RequestFileError("loop implementers must use the Lead's provider")
        if not {"cwd", "prompt-file"} <= keys:
            raise RequestFileError("loop requires cwd and prompt-file")
        if not Path(metadata["cwd"]).is_absolute() or not Path(metadata["cwd"]).is_dir():
            raise RequestFileError("loop cwd must be an existing absolute directory")
        if not Path(metadata["prompt-file"]).is_absolute() or not Path(metadata["prompt-file"]).is_file():
            raise RequestFileError("loop prompt-file must be an existing absolute file")
        if metadata.get("difficulty") not in (None, "routine", "basic", "advanced", "expert"):
            raise RequestFileError("unsupported loop difficulty")
    prompt = "\n".join(lines[closing + 1 :]).strip()
    if not prompt:
        raise RequestFileError("request body must be nonempty")
    if SKILL_INVOCATION.search(prompt):
        raise RequestFileError(
            "request body must be a plain prompt, not a skill invocation"
        )
    return DelegationRequest(
        canonical_path, task, provider, mode, prompt,
        cwd=Path(metadata["cwd"]).resolve() if task == "loop" else None,
        difficulty=metadata.get("difficulty"),
        prompt_path=Path(metadata["prompt-file"]).resolve() if task == "loop" else None,
        child_skill=policy.skill,
        model=metadata["model"].strip() if "model" in metadata else None,
    )


def _sessions_module():
    # Import lazily: sessions owns the shared SQLite connection and imports
    # request parsing only when a conversation inbox is processed.
    from subagents_runtime import sessions

    return sessions


def enable_delegation(
    parent_session_id: str, skill: str, *, original_cwd: Path | None = None
) -> DelegationInbox:
    """Enable the saved conversation's inbox; subsequent invocations reuse it."""
    sessions = _sessions_module()
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT provider,cwd FROM sessions WHERE id=?", (parent_session_id,)
        ).fetchone()
        if row is None:
            raise sessions.SessionError(
                "the current Harness parent session is not registered"
            )
        if skill not in {"resume-agent", "ship"}:
            try:
                policies = load_task_policies(original_cwd or Path(row[1]), row[0])
            except RoleError as exc:
                raise sessions.SessionError(str(exc)) from exc
            if skill not in policies:
                raise sessions.SessionError(f"unknown delegation skill {skill!r}")
        select = "SELECT inbox FROM session_delegation WHERE parent_session_id=?"
        existing = connection.execute(select, (parent_session_id,)).fetchone()
        if existing is None:
            inbox = new_inbox()
            connection.execute(
                "INSERT OR IGNORE INTO session_delegation(parent_session_id,inbox) VALUES (?,?)",
                (parent_session_id, str(inbox)),
            )
            stored = connection.execute(select, (parent_session_id,)).fetchone()[0]
            if Path(stored) != inbox:
                # A concurrent invocation enabled this conversation first.
                inbox.rmdir()
        else:
            stored = existing[0]
            Path(stored).mkdir(parents=True, exist_ok=True)
    return DelegationInbox(
        parent_session_id, parent_session_id, row[0], Path(row[1]), Path(stored)
    )


def _load_inbox(session_id: str) -> DelegationInbox:
    with _sessions_module()._connect() as connection:
        row = connection.execute(
            "SELECT s.provider,s.cwd,d.inbox FROM sessions s JOIN session_delegation d ON d.parent_session_id=s.id WHERE s.id=?",
            (session_id,),
        ).fetchone()
    if row is None:
        raise _sessions_module().SessionError(
            "harness ask requires an enabled session inbox"
        )
    return DelegationInbox(session_id, session_id, row[0], Path(row[1]), Path(row[2]))


def _finish_launch(request, request_id, execution_id, child_id, number, cwd, path, launch):
    from subagents_runtime import processes
    sessions = _sessions_module()
    if request.provider == "chatgpt":
        from subagents_runtime.prompt_paths import normalize_file_references

        # Hash and retain the original inbox body; adapt only the launch copy,
        # after continuations have recovered their child's provider and cwd.
        request = replace(request, prompt=normalize_file_references(request.prompt, cwd))
    launched_id = launch(request, request_id, number, cwd)
    with sessions._connect() as connection:
        if launched_id != child_id:
            connection.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (launched_id, child_id))
        connection.execute("UPDATE requests SET state='pending' WHERE id=? AND state='launching'", (request_id,))
    processes.confirm_startup(execution_id)
    with sessions._connect() as connection:
        confirmed = connection.execute("SELECT state FROM executions WHERE id=?", (execution_id,)).fetchone()[0]
        if confirmed not in {"running", "exited"}:
            return ProcessResult(path, "uncertain", request_id, child_id, "Awaiting provider startup")
        path.with_name(path.name + ".running").unlink(missing_ok=True)
        connection.execute("UPDATE requests SET source_deleted_at=CURRENT_TIMESTAMP WHERE id=?", (request_id,))
    return ProcessResult(path, "launched", request_id, child_id)


def _fail_request(path, request_id, execution_id, child_id, exc, session_id):
    sessions = _sessions_module()
    claimed = path.with_name(path.name + ".running")
    with sessions._connect() as connection:
        exists = connection.execute(
            "SELECT 1 FROM requests WHERE id=?", (request_id,)
        ).fetchone()
        execution = connection.execute(
            "SELECT state FROM executions WHERE id=?", (execution_id,)
        ).fetchone()
        uncertain = execution and execution[0] in {
            "starting",
            "running",
            "uncertain",
        }
        state = "uncertain" if uncertain else "failed"
        if exists:
            connection.execute(
                "UPDATE requests SET state=?,reason=?,delivery_id=CASE WHEN ?='failed' THEN COALESCE(delivery_id,?) ELSE delivery_id END,completed_at=CASE WHEN ?='failed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?",
                (state, str(exc), state, str(uuid.uuid4()), state, request_id),
            )
            connection.execute(
                "UPDATE executions SET state=? WHERE id=?",
                ("uncertain" if uncertain else "failed", execution_id),
            )
            if not uncertain:
                connection.execute("UPDATE loop_sessions SET active=0,released_at=CURRENT_TIMESTAMP WHERE session_id=?", (child_id,))
        else:
            connection.execute(
                "INSERT OR IGNORE INTO requests(id,parent_session_id,source_name,state,reason,delivery_id,completed_at) VALUES (?,?,?,'failed',?,?,CURRENT_TIMESTAMP)",
                (
                    request_id,
                    session_id,
                    path.name,
                    str(exc),
                    str(uuid.uuid4()),
                ),
            )
    if uncertain:
        with sessions._connect() as connection:
            connection.execute(
                "UPDATE executions SET reservation_pid=NULL,reservation_birth=NULL WHERE id=?",
                (execution_id,),
            )
    if not uncertain:
        path.unlink(missing_ok=True)
        claimed.unlink(missing_ok=True)
        with sessions._connect() as connection:
            connection.execute("UPDATE requests SET source_deleted_at=CURRENT_TIMESTAMP WHERE id=?", (request_id,))
            # A fork that never started leaves no copy to speak through; the child keeps
            # the conversation it already had, so it stays resumable.
            connection.execute(
                "UPDATE sessions SET provider_session_id=(SELECT fork_of FROM executions WHERE id=?) WHERE id=(SELECT session_id FROM executions WHERE id=? AND fork_of IS NOT NULL)",
                (execution_id, execution_id),
            )
    return ProcessResult(path, state, request_id, child_id, str(exc))


def _supersede_child(connection, child_session_id: str) -> None:
    """Release a live child's claim so a forked continuation can take its place.

    The original execution keeps running wherever the user left it; only its hold on
    the child's identity ends, and its unfinished request is settled for the parent.
    """
    connection.execute(
        "UPDATE executions SET superseded_at=CURRENT_TIMESTAMP WHERE session_id=? AND superseded_at IS NULL AND state IN ('prepared','starting','running','uncertain')",
        (child_session_id,),
    )
    connection.execute(
        "DELETE FROM reply_authorizations WHERE child_session_id=?", (child_session_id,)
    )
    # Born acknowledged: the continuation the parent asked for is the answer to this
    # request, so its settlement is never delivered as a result of its own.
    connection.execute(
        "UPDATE requests SET state='cancelled',reason=COALESCE(reason,?),completed_at=CURRENT_TIMESTAMP,acknowledgement_sequence=COALESCE(acknowledgement_sequence,0),acknowledged_at=CURRENT_TIMESTAMP WHERE child_session_id=? AND state IN ('launching','pending','uncertain')",
        (
            "superseded by a forked continuation; its original session stays open",
            child_session_id,
        ),
    )


def reconcile_inbox(session_id: str, *, launch: Callable | None = None) -> list[ProcessResult]:
    """Recover claims conservatively: an unconfirmed spawn is never repeated."""
    from subagents_runtime import processes

    sessions = _sessions_module()
    delegation = _load_inbox(session_id)
    if delegation.inbox.is_symlink() or delegation.inbox.resolve() != delegation.inbox:
        raise sessions.SessionError("The session inbox is no longer canonical")
    results = []
    retries = []
    for path in delegation.inbox.glob("*.md.running"):
        source = path.name[:-8]
        with sessions._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not path.exists():
                continue
            row = connection.execute(
                "SELECT id,state,child_session_id FROM requests WHERE parent_session_id=? AND source_name=?",
                (session_id, source),
            ).fetchone()
            if row is None:
                # Atomic claim happened before reservation: no backend could have started.
                path.replace(path.with_name(source))
                continue
            execution = connection.execute(
                "SELECT state,reservation_pid,reservation_birth,id FROM executions WHERE request_id=?",
                (row[0],),
            ).fetchone()
            if execution and execution[0] in {"failed", "cancelled"}:
                connection.execute(
                    "UPDATE requests SET state=?,reason=COALESCE(reason,?),delivery_id=COALESCE(delivery_id,?),completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP) WHERE id=? AND state IN ('launching','pending','uncertain')",
                    (execution[0], "Provider startup failed" if execution[0] == "failed" else "Execution cancelled", str(uuid.uuid4()), row[0]),
                )
            if (
                row[1] in {"succeeded", "failed", "cancelled"}
                or execution
                and execution[0] in {"running", "exited", "failed", "cancelled"}
            ):
                path.unlink(missing_ok=True)
                connection.execute(
                    "UPDATE requests SET source_deleted_at=CURRENT_TIMESTAMP WHERE id=?",
                    (row[0],),
                )
            else:
                if (
                    execution
                    and execution[1]
                    and ((execution[2] is not None and processes.birth_identity(execution[1]) == execution[2])
                         or ((execution[2] is None or processes.birth_identity(execution[1]) is None) and processes.process_alive(execution[1])))
                ):
                    continue
                if execution and execution[0] == "prepared" and launch is not None:
                    # Every backend must commit 'starting' before spawn. A prepared
                    # reservation whose owner is gone therefore cannot have spawned.
                    connection.execute("UPDATE executions SET reservation_pid=?,reservation_birth=? WHERE id=?",
                                       (os.getpid(), processes.birth_identity(os.getpid()), execution[3]))
                    persisted = connection.execute(
                        "SELECT r.task,r.provider,r.mode,r.prompt_hash,s.cwd,s.agent_index,r.kind,s.model FROM requests r JOIN sessions s ON s.id=r.child_session_id WHERE r.id=?", (row[0],)
                    ).fetchone()
                    retries.append((path, row[0], execution[3], row[2], persisted))
                    continue
                connection.execute(
                    "UPDATE requests SET state='uncertain',reason='Startup could not be verified' WHERE id=? AND state IN ('launching','pending')",
                    (row[0],),
                )
                connection.execute(
                    "UPDATE executions SET state='uncertain' WHERE request_id=? AND state IN ('prepared','starting')",
                    (row[0],),
                )
                results.append(
                    ProcessResult(
                        path,
                        "uncertain",
                        row[0],
                        row[2],
                        "Startup could not be verified",
                    )
                )
    from dataclasses import replace
    for claimed_path, request_id, execution_id, child_id, persisted in retries:
        path = claimed_path.with_name(claimed_path.name[:-8])
        try:
            request = parse_request_file(claimed_path, delegation.inbox, parent_provider=delegation.provider, claimed=True, cwd=delegation.original_cwd)
            task, provider, mode, prompt_hash, cwd, number, kind, model = persisted
            if hashlib.sha256(request.prompt.encode()).hexdigest() != prompt_hash or bool(request.resume) != (kind == "resume"):
                raise RequestFileError("Claimed request content changed after reservation")
            if kind == "launch" and (request.task, request.provider, request.mode, request.model) != (task, provider, mode, model):
                raise RequestFileError("Claimed request metadata changed after reservation")
            if kind == "resume" and sessions.resolve_session(request.resume, session_id) != child_id:
                raise RequestFileError("Claimed request child changed after reservation")
            request = replace(request, path=path, task=task, provider=provider, mode=mode, model=model)
            results.append(_finish_launch(request, request_id, execution_id, child_id, number, Path(cwd), path, launch))
        except Exception as exc:
            results.append(_fail_request(path, request_id, execution_id, child_id, exc, session_id))
    reported = {result.request_id for result in results}
    with sessions._connect() as connection:
        uncertain = connection.execute(
            "SELECT id,child_session_id,source_name,reason FROM requests WHERE parent_session_id=? AND state='uncertain'",
            (session_id,),
        ).fetchall()
    for request_id, child_id, source_name, reason in uncertain:
        if request_id not in reported:
            results.append(
                ProcessResult(
                    delegation.inbox
                    / ((source_name or request_id + ".md") + ".running"),
                    "uncertain",
                    request_id,
                    child_id,
                    reason or "Execution could not be verified",
                )
            )
    return results


def process_inbox(
    session_id: str, *, launch: Callable, request_paths: set[Path] | None = None,
    allow_loop_resume: bool = False,
) -> list[ProcessResult]:
    """Claim, reserve, and start requests in a persistent conversation inbox."""
    from dataclasses import replace

    from subagents_runtime import processes

    sessions = _sessions_module()
    delegation = _load_inbox(session_id)
    if (
        not delegation.inbox.is_dir()
        or delegation.inbox.is_symlink()
        or delegation.inbox.resolve() != delegation.inbox
    ):
        raise sessions.SessionError(
            "the session inbox is missing or no longer canonical"
        )
    results = reconcile_inbox(session_id, launch=launch)
    candidates = (
        None if request_paths is None else {p.absolute() for p in request_paths}
    )
    for path in sorted(delegation.inbox.iterdir()):
        if path.name.endswith(".running") or (path.is_dir() and not path.is_symlink()):
            continue
        if candidates is not None and path.absolute() not in candidates:
            continue
        request_id = str(uuid.uuid4())
        execution_id = str(uuid.uuid4())
        child_id = None
        claimed = path.with_name(path.name + ".running")
        try:
            request = parse_request_file(
                path, delegation.inbox, parent_provider=delegation.provider,
                cwd=delegation.original_cwd,
            )
            if claimed.exists():
                continue
            fork = False
            fork_of = None
            if request.resume:
                # A live child is continued in a copy of its transcript, exactly as the
                # providers' own fork commands do; its open session is left alone.
                fork = bool(
                    processes.live_executions(
                        sessions.resolve_session(request.resume, session_id)
                    )
                )
            elif request.mode == "loop":
                from subagents_runtime.loop import reconcile_worktree

                reconcile_worktree(request.cwd or delegation.original_cwd)
            with sessions._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if connection.execute(
                    "SELECT 1 FROM requests WHERE parent_session_id=? AND source_name=?",
                    (session_id, path.name),
                ).fetchone():
                    raise RequestFileError(
                        "request filename was already used; retry with a fresh filename"
                    )
                if claimed.exists() or not path.exists():
                    continue
                path.rename(claimed)
                if request.resume:
                    child_id = sessions.resolve_session(request.resume, session_id)
                    row = connection.execute(
                        "SELECT provider,execution_mode,cwd,agent_index,provider_session_id,model FROM sessions WHERE id=? AND parent_session_id=?",
                        (child_id, session_id),
                    ).fetchone()
                    if row is None:
                        raise RequestFileError(
                            "child is not owned by this conversation"
                        )
                    if not row[4]:
                        raise RequestFileError(
                            "Provider conversation has not been bound; resume refused"
                        )
                    if row[1] == "loop":
                        if not allow_loop_resume:
                            raise RequestFileError("Use loop feedback or loop resume for a loop implementer")
                        record = connection.execute("SELECT active,difficulty FROM loop_sessions WHERE session_id=?", (child_id,)).fetchone()
                        if record[0]:
                            raise RequestFileError("Release the previous wait before resuming an idle implementer")
                        if fork:
                            backend = connection.execute("SELECT backend FROM executions WHERE session_id=? AND superseded_at IS NULL AND state IN ('running','starting','uncertain','prepared')", (child_id,)).fetchone()
                            if not backend or backend[0] != "aboard":
                                raise RequestFileError("Standalone implementer terminal is still open; close it before resuming, or launch a fresh implementer")
                        try:
                            connection.execute("UPDATE loop_sessions SET active=1,released_at=NULL WHERE session_id=?", (child_id,))
                            connection.execute("DELETE FROM loop_waits WHERE session_id=?", (child_id,))
                        except Exception as exc:
                            raise RequestFileError("worktree already has an active loop implementer") from exc
                        request = replace(request, difficulty=record[1])
                    original = connection.execute(
                        "SELECT task FROM requests WHERE child_session_id=? ORDER BY created_at LIMIT 1",
                        (child_id,),
                    ).fetchone()
                    # Continuations keep the workflow already in the transcript,
                    # even if its project registry has since changed or been removed.
                    if fork:
                        fork_of = row[4] if row[1] != "loop" else None
                        _supersede_child(connection, child_id)
                    request = replace(
                        request, provider=row[0], mode=row[1], task=original[0], model=row[5]
                    )
                    cwd, number = Path(row[2]), row[3]
                else:
                    number = connection.execute(
                        "SELECT MAX(n)+1 FROM (SELECT COALESCE(MAX(agent_index),0) n FROM sessions WHERE parent_session_id=? UNION ALL SELECT COALESCE(MAX(agent_number),0) FROM requests WHERE parent_session_id=?)",
                        (session_id, session_id),
                    ).fetchone()[0]
                    child_id = str(uuid.uuid4())
                    cwd = request.cwd or delegation.original_cwd
                    if request.mode == "loop":
                        from subagents_runtime.loop import worktree_key
                        if connection.execute("SELECT 1 FROM loop_sessions WHERE worktree_key=? AND active=1", (worktree_key(cwd),)).fetchone():
                            raise RequestFileError("worktree already has an active loop implementer; release it first")
                    connection.execute(
                        "INSERT INTO sessions(id,cwd,provider,execution_mode,parent_session_id,agent_index,model) VALUES (?,?,?,?,?,?,?)",
                        (
                            child_id,
                            str(cwd),
                            request.provider,
                            request.mode,
                            session_id,
                            number,
                            request.model,
                        ),
                    )
                    if request.mode == "loop":
                        connection.execute(
                            "INSERT INTO loop_sessions(session_id,worktree_key,prompt_path,difficulty) VALUES (?,?,?,?)",
                            (child_id, worktree_key(cwd), str(request.prompt_path), request.difficulty),
                        )
                connection.execute(
                    "INSERT INTO requests(id,kind,parent_session_id,child_session_id,agent_number,source_name,task,provider,mode,prompt_hash,state) VALUES (?,?,?,?,?,?,?,?,?,?,'launching')",
                    (
                        request_id,
                        "resume" if request.resume else "launch",
                        session_id,
                        child_id,
                        number,
                        path.name,
                        request.task,
                        request.provider,
                        request.mode,
                        hashlib.sha256(request.prompt.encode()).hexdigest(),
                    ),
                )
                connection.execute(
                    "INSERT INTO executions(id,session_id,request_id,backend,state,reservation_pid,reservation_birth,fork_of) VALUES (?,?,?,'standalone','prepared',?,?,?)",
                    (
                        execution_id,
                        child_id,
                        request_id,
                        os.getpid(),
                        processes.birth_identity(os.getpid()),
                        fork_of,
                    ),
                )
            results.append(_finish_launch(request, request_id, execution_id, child_id, number, cwd, path, launch))
        except Exception as exc:  # Persist failures from validation or launch adapters.
            results.append(_fail_request(path, request_id, execution_id, child_id, exc, session_id))
    return results


def _next_sequence(connection, session_id: str) -> int:
    connection.execute(
        "UPDATE sessions SET hook_sequence = hook_sequence + 1 WHERE id = ?",
        (session_id,),
    )
    row = connection.execute(
        "SELECT hook_sequence FROM sessions WHERE id = ?", (session_id,)
    ).fetchone()
    if row is None:
        raise _sessions_module().SessionError(f"unknown Harness session {session_id}")
    return int(row[0])


def _active_request(
    connection, child_session_id: str, execution_id: str | None, *, interactive: bool = False
):
    """The request this execution answers for.

    A reused terminal keeps its original hook environment. Explicit input ownership
    routes those hooks to its current continuation; a fork keeps separate ownership.
    """
    scoped = (
        connection.execute(
            "SELECT request_id FROM executions WHERE session_id=? AND (id=? OR input_execution_id=?) ORDER BY (superseded_at IS NULL) DESC, rowid DESC LIMIT 1",
            (child_session_id, execution_id, execution_id),
        ).fetchone()
        if execution_id
        else None
    )
    request_id = scoped[0] if scoped else None
    return connection.execute(
        "SELECT id, mode, state FROM requests WHERE child_session_id = ?"
        " AND state IN ('launching','pending','uncertain') AND (? IS NULL OR id = ?)"
        + (" AND mode = 'interactive'" if interactive else ""),
        (child_session_id, request_id, request_id),
    ).fetchone()


def arm_reply(child_session_id: str, execution_id: str | None = None) -> None:
    sessions = _sessions_module()
    with sessions._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _active_request(
            connection, child_session_id, execution_id, interactive=True
        )
        if row is None:
            connection.rollback()
            raise sessions.SessionError("no pending interactive parent request")
        sequence = _next_sequence(connection, child_session_id)
        try:
            connection.execute(
                "INSERT INTO reply_authorizations(request_id, child_session_id, armed_sequence) VALUES (?, ?, ?)",
                (row[0], child_session_id, sequence),
            )
        except Exception as exc:
            connection.rollback()
            if "UNIQUE" in str(exc):
                raise sessions.SessionError("a reply is already armed") from exc
            raise
        connection.commit()


def clear_reply_authorization(child_session_id: str) -> bool:
    """Clear a one-shot reply after an interrupted or failed child turn."""
    with _sessions_module()._connect() as connection:
        changed = connection.execute(
            "DELETE FROM reply_authorizations WHERE child_session_id = ?",
            (child_session_id,),
        )
        return changed.rowcount == 1


def report_child_stop(
    child_session_id: str,
    message: str,
    *,
    success: bool,
    reason: str | None = None,
    cancelled: bool = False,
    execution_id: str | None = None,
) -> bool:
    """Resolve an auto request or consume an interactive one-shot reply."""
    with _sessions_module()._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _active_request(connection, child_session_id, execution_id)
        if row is None:
            connection.rollback()
            return False
        request_id, mode, _state = row
        if mode == "interactive":
            if cancelled:
                connection.execute(
                    "DELETE FROM reply_authorizations WHERE request_id = ?",
                    (request_id,),
                )
            else:
                authorization = connection.execute(
                    "SELECT 1 FROM reply_authorizations WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if authorization is None:
                    connection.rollback()
                    return False
                connection.execute(
                    "DELETE FROM reply_authorizations WHERE request_id = ?",
                    (request_id,),
                )
                if not success:
                    connection.commit()
                    return False
        state = "succeeded" if success else ("cancelled" if cancelled else "failed")
        delivery_id = str(uuid.uuid4())
        changed = connection.execute(
            """
            UPDATE requests SET state = ?, reply = ?, reason = ?, delivery_id = ?, completed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND state IN ('launching','pending','uncertain')
            """,
            (state, message if success else None, reason, delivery_id, request_id),
        )
        connection.commit()
        return changed.rowcount == 1


def observe_parent_event(parent_session_id: str, event: str) -> None:
    if event not in {"PreToolUse", "PostToolUse", "Stop"}:
        return
    with _sessions_module()._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        sequence = _next_sequence(connection, parent_session_id)
        connection.execute(
            """
            UPDATE requests SET acknowledgement_sequence = ?, acknowledged_at = CURRENT_TIMESTAMP
            WHERE parent_session_id = ? AND claim_sequence IS NOT NULL
              AND acknowledgement_sequence IS NULL AND claim_sequence < ?
            """,
            (sequence, parent_session_id, sequence),
        )
        connection.execute(
            "UPDATE session_delegation SET acknowledgement_sequence=? WHERE parent_session_id=? AND claim_sequence IS NOT NULL AND claim_sequence < ? AND acknowledgement_sequence IS NULL",
            (sequence, parent_session_id, sequence),
        )
        connection.commit()


def lead_instructions(session_id: str, inbox: str | Path) -> str:
    """The /ship Lead drives implementers through `harness loop`; the inbox only serves its explorer."""
    return (
        f"Ship Lead runtime session: {session_id}. Pass --parent {session_id} to "
        f"harness loop launch when HARNESS_SESSION_ID is unset.\nExplorer inbox: {inbox}\n"
    )


def claim_instructions(
    session_id: str, *, compact: bool = False, lead: bool | None = None
) -> str | None:
    """Replay runtime context until acknowledged, refreshing it after compaction."""
    sessions = _sessions_module()
    with sessions._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if lead is None:
            lead = connection.execute(
                "SELECT 1 FROM requests WHERE parent_session_id=? AND task='loop' LIMIT 1",
                (session_id,),
            ).fetchone() is not None
        row = connection.execute(
            "SELECT inbox,context_epoch,injected_epoch,claim_sequence,acknowledgement_sequence FROM session_delegation WHERE parent_session_id=?",
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        inbox, epoch, injected, claimed, acknowledged = row
        if compact:
            epoch += 1
            injected = claimed = acknowledged = None
            connection.execute(
                "UPDATE session_delegation SET context_epoch=?,injected_epoch=NULL,claim_sequence=NULL,acknowledgement_sequence=NULL WHERE parent_session_id=?",
                (epoch, session_id),
            )
        if injected == epoch and acknowledged is not None:
            return None
        sequence = _next_sequence(connection, session_id)
        if claimed is None:
            connection.execute(
                "UPDATE session_delegation SET injected_epoch=?,claim_sequence=?,acknowledgement_sequence=NULL WHERE parent_session_id=?",
                (epoch, sequence, session_id),
            )
        cwd = Path(connection.execute("SELECT cwd FROM sessions WHERE id=?", (session_id,)).fetchone()[0])
    if lead:
        return lead_instructions(session_id, inbox)
    from subagents_runtime.roles import custom_registry_paths

    personal_registry, project_registry = custom_registry_paths(cwd)
    return (
        f"Conversation inbox: {inbox}\n"
        "Write inbox requests with a structured file-writing tool such as Write or apply_patch; "
        "the write event launches the request automatically.\n"
        f"Custom task registries: project {project_registry}; personal {personal_registry}. "
        "Project entries replace personal definitions by task name. "
        "Missing files mean no custom tasks; report malformed registries instead of falling back.\n"
        "Invoke the subagents-toolkit skill before launching or continuing a subagent "
        "if its instructions are not already in the current context.\n"
    )


def _plural(total: int, singular: str, plural: str) -> str:
    return singular if total == 1 else plural


def _delegation_status(connection, parent_session_id: str) -> str:
    """What the parent must know to act: who is working, who owes a reply, who can be resumed."""
    active = dict(
        connection.execute(
            "SELECT mode,count(*) FROM requests WHERE parent_session_id=? AND state IN ('launching','pending','uncertain') GROUP BY mode",
            (parent_session_id,),
        ).fetchall()
    )
    running = int(active.get("auto", 0))
    owed = int(active.get("interactive", 0))
    implementing = int(active.get("loop", 0))
    awaiting_verdict = int(
        connection.execute(
            "SELECT count(*) FROM loop_waits w JOIN sessions s ON s.id = w.session_id "
            "WHERE s.parent_session_id = ? AND w.state = 'waiting'",
            (parent_session_id,),
        ).fetchone()[0]
    )
    # Loop implementers continue only through `harness loop`, never inbox resume.
    idle = int(
        connection.execute(
            """
            SELECT count(*) FROM sessions s WHERE s.parent_session_id = ?
              AND s.provider_session_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM loop_sessions l WHERE l.session_id = s.id)
              AND NOT EXISTS (
                SELECT 1 FROM requests r WHERE r.child_session_id = s.id
                  AND r.state IN ('launching','pending','uncertain')
              )
            """,
            (parent_session_id,),
        ).fetchone()[0]
    )

    parts = []

    if running:
        parts.append(
            f"{running} auto {_plural(running, 'agent is', 'agents are')} still running"
        )

    if implementing:
        parts.append(
            f"{implementing} loop {_plural(implementing, 'implementer is', 'implementers are')} still working"
        )

    if awaiting_verdict:
        parts.append(
            f"{awaiting_verdict} loop {_plural(awaiting_verdict, 'implementer awaits', 'implementers await')} your verdict"
        )

    if owed:
        parts.append(
            f"{owed} interactive {_plural(owed, 'agent', 'agents')} still "
            f"{_plural(owed, 'owes', 'owe')} a reply"
        )

    if idle:
        parts.append(
            f"{idle} {_plural(idle, 'agent is', 'agents are')} idle and available for resume"
        )

    return ", ".join(parts) + "." if parts else ""


def _format_loop_event(identifier: str, reply: str) -> str | None:
    """Render runtime loop events as prose with the implementer's report kept verbatim."""
    try:
        event = json.loads(reply)
    except ValueError:
        return None
    kind = event.get("event") if isinstance(event, dict) else None
    if kind not in {"report", "takeover", "wait-expired"}:
        return None
    if kind == "takeover":
        return (
            f"{identifier} was taken over by the user ({event.get('reason')}). "
            "Discard any verdict on its previous report and wait for its next report."
        )
    if kind == "wait-expired":
        return (
            f"{identifier}'s wait expired. End this loop with [AI]-needs-decision, "
            "a draft PR, and a precise issue comment."
        )
    usage = event.get("context_usage") or {}
    percentage, window = usage.get("used_percentage"), usage.get("context_window")
    context = f"{percentage:.0f}% of {window:,} tokens" if percentage is not None and window else "unknown"
    lines = [f"{identifier} implementer report. Wait token: {event.get('wait_token')}. Context: {context}."]
    steering = event.get("user_messages") or []
    if steering:
        lines.append("User messages since the previous report:")
        lines.extend(
            f"- to {'the implementer' if item.get('source') == event.get('session_id') else 'you'}: {item.get('message')}"
            for item in steering
        )
    lines.append(f"<report>\n{event.get('report')}\n</report>")
    return "\n".join(lines)


def _format_results(rows, status: str) -> str:
    messages: list[str] = []
    for row in rows:
        _request_id, number, state, reply, reason, _delivery_id = row[:6]
        mode = row[7] if len(row) > 7 else None
        identifier = (
            f"agent-{number}" if number is not None else f"Request {_request_id}"
        )
        loop_event = _format_loop_event(identifier, reply) if state == "succeeded" and mode == "loop" and reply else None
        if loop_event:
            messages.append(loop_event)
        elif state == "succeeded":
            messages.append(f"{identifier} finished. Agent replied:\n<reply>\n{reply}\n</reply>")
        elif state == "cancelled":
            detail = f" Reason: {reason}." if reason and reason != "other" else ""
            messages.append(
                f"{identifier}'s session ended before a reply was sent to the parent."
                f"{detail} Its work may have completed. Ask the user to provide the "
                "child's reply, or offer to resume the child so it can send its result."
            )
        else:
            messages.append(f"{identifier} failed: {reason or 'unknown failure'}.")
    messages.append(status)
    return "\n" + "\n\n".join(messages)


def claim_parent_delivery(parent_session_id: str, event: str) -> ParentDelivery | None:
    """Claim ready results, replaying the same claim until a later acknowledgement."""
    with _sessions_module()._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        sequence = _next_sequence(connection, parent_session_id)
        state_filter = "AND state IN ('succeeded', 'failed', 'cancelled')"
        rows = connection.execute(
            f"""
            SELECT id, agent_number, state, reply, reason, delivery_id, claim_sequence, mode
            FROM requests WHERE parent_session_id = ? {state_filter}
              AND acknowledgement_sequence IS NULL
            ORDER BY agent_number
            """,
            (parent_session_id,),
        ).fetchall()
        if not rows:
            connection.commit()
            return None
        claimed = [row for row in rows if row[6] is not None]
        unclaimed = [row for row in rows if row[6] is None]
        selected = claimed or unclaimed
        if not claimed:
            for row in selected:
                connection.execute(
                    "UPDATE requests SET claim_sequence = ?, claimed_at = CURRENT_TIMESTAMP WHERE id = ? AND claim_sequence IS NULL",
                    (sequence, row[0]),
                )
        delivery_id = selected[0][5]
        text = _format_results(selected, _delegation_status(connection, parent_session_id))
        connection.commit()
        return ParentDelivery(delivery_id, text)


def has_pending_children(parent_session_id: str) -> bool:
    with _sessions_module()._connect() as connection:
        return (
            connection.execute(
                "SELECT 1 FROM requests WHERE parent_session_id = ? AND state IN ('launching', 'pending') LIMIT 1",
                (parent_session_id,),
            ).fetchone()
            is not None
        )


def wait_parent_delivery(
    parent_session_id: str,
    *,
    timeout_seconds: float,
    poll_seconds: float = 0.25,
) -> ParentDelivery | None:
    """Wait without retaining a transaction; only successes wake the parent."""
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        delivery = claim_parent_delivery(parent_session_id, "Stop")
        if delivery is not None:
            return delivery
        if not has_pending_children(parent_session_id):
            return None
        if time.monotonic() >= deadline:
            from subagents_runtime.loop import expire_parent_wait
            expire_parent_wait(parent_session_id)
            return claim_parent_delivery(parent_session_id, "Stop")
        time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))
