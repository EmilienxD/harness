"""Task-bound delegation grants and request-file protocol."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import yaml


PROVIDERS = frozenset({"claude", "chatgpt"})
SKILL_INVOCATION = re.compile(r"^[/\$][A-Za-z0-9_-]+(?:\s|$)")


class RequestFileError(ValueError):
    """A request file is unsafe, malformed, or outside its grant."""


@dataclass(frozen=True)
class GrantPolicy:
    task: str
    modes: frozenset[str]


GRANT_POLICIES = {
    "ask-agent-to-explore": GrantPolicy("explore", frozenset({"auto"})),
    "ask-agent-to-prototype": GrantPolicy("prototype", frozenset({"interactive", "auto"})),
    "ask-agent-to-websearch": GrantPolicy("websearch", frozenset({"interactive", "auto"})),
    "ask-agent-to-brainstorm": GrantPolicy("brainstorm", frozenset({"interactive"})),
    "ask-agent": GrantPolicy("general", frozenset({"interactive", "auto"})),
}


@dataclass(frozen=True)
class DelegationRequest:
    path: Path
    task: str
    provider: str
    mode: str
    prompt: str


@dataclass(frozen=True)
class DelegationGrant:
    id: str
    parent_session_id: str
    skill: str
    policy: GrantPolicy
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
            raise RequestFileError("request file is outside the canonical inbox") from exc
        raise RequestFileError("request file must be a direct child of the canonical inbox")
    if canonical_path.parent != canonical_inbox:
        raise RequestFileError("request file is outside the canonical inbox")
    return canonical_path, canonical_inbox


def parse_request_file(
    path: Path,
    inbox: Path,
    policy: GrantPolicy,
    *,
    parent_provider: str,
) -> DelegationRequest:
    canonical_path, _ = _canonical_direct_child(path, inbox)
    if canonical_path.suffix.lower() != ".md":
        raise RequestFileError("request file must be Markdown (*.md)")
    try:
        raw = canonical_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RequestFileError(f"request file cannot be read as UTF-8: {exc}") from exc
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        raise RequestFileError("request file must start with YAML frontmatter")
    try:
        closing = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration as exc:
        raise RequestFileError("request file has unclosed YAML frontmatter") from exc
    try:
        metadata = yaml.safe_load("\n".join(lines[1:closing]))
    except yaml.YAMLError as exc:
        raise RequestFileError(f"invalid YAML frontmatter: {exc}") from exc
    if not isinstance(metadata, dict):
        raise RequestFileError("frontmatter must be a mapping")
    keys = set(metadata)
    accepted = {"task", "provider", "mode"}
    if extras := keys - accepted:
        raise RequestFileError("unsupported frontmatter keys: " + ", ".join(sorted(map(str, extras))))
    for key in ("task", "mode"):
        if key not in metadata:
            raise RequestFileError(f"frontmatter requires {key}")
    for key, value in metadata.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value.strip():
            raise RequestFileError(f"frontmatter {key!s} must be a nonempty scalar string")
    task = metadata["task"].strip()
    mode = metadata["mode"].strip()
    provider = metadata.get("provider", parent_provider).strip()
    if task != policy.task:
        raise RequestFileError(f"grant does not authorize task {task!r}")
    if mode not in policy.modes:
        raise RequestFileError(f"grant does not authorize mode {mode!r}")
    if provider not in PROVIDERS:
        raise RequestFileError(f"unsupported provider {provider!r}")
    prompt = "\n".join(lines[closing + 1 :]).strip()
    if not prompt:
        raise RequestFileError("request body must be nonempty")
    if SKILL_INVOCATION.match(prompt):
        raise RequestFileError("request body must be a plain prompt, not a skill invocation")
    return DelegationRequest(canonical_path, task, provider, mode, prompt)


def _sessions_module():
    # Import lazily: sessions owns the shared SQLite connection and imports
    # request parsing only when a grant is consumed.
    from harness_cli import sessions

    return sessions


def open_grant(parent_session_id: str, skill: str, *, original_cwd: Path | None = None) -> DelegationGrant:
    sessions = _sessions_module()
    policy = GRANT_POLICIES.get(skill)
    if policy is None:
        raise sessions.SessionError(f"unknown delegation skill {skill!r}")
    with sessions._connect() as connection:
        row = connection.execute(
            "SELECT provider, cwd, execution_mode FROM sessions WHERE id = ?",
            (parent_session_id,),
        ).fetchone()
        if row is None:
            raise sessions.SessionError("the current Harness parent session is not registered")
        provider, registered_cwd, execution_mode = row
        if execution_mode != "interactive":
            raise sessions.SessionError(f"{execution_mode} children cannot delegate")
        grant_id = uuid.uuid4().hex
        cwd = (original_cwd or Path(registered_cwd)).resolve()
        inbox = cwd / ".harness" / "runtime" / "sessions" / parent_session_id / grant_id / "inbox"
        inbox.mkdir(parents=True, exist_ok=False)
        connection.execute(
            """
            INSERT INTO grants(id, parent_session_id, skill, task, modes, provider, original_cwd, inbox, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
            """,
            (
                grant_id,
                parent_session_id,
                skill,
                policy.task,
                json.dumps(sorted(policy.modes)),
                provider,
                str(cwd),
                str(inbox.resolve()),
            ),
        )
    return DelegationGrant(grant_id, parent_session_id, skill, policy, provider, cwd, inbox.resolve())


def _load_live_grant(grant_id: str) -> DelegationGrant:
    sessions = _sessions_module()
    with sessions._connect() as connection:
        row = connection.execute(
            """
            SELECT parent_session_id, skill, task, modes, provider, original_cwd, inbox
            FROM grants WHERE id = ? AND state IN ('open', 'used')
            """,
            (grant_id,),
        ).fetchone()
    if row is None:
        raise sessions.SessionError("harness ask requires a live skill grant")
    parent, skill, task, modes, provider, cwd, inbox = row
    return DelegationGrant(
        grant_id,
        parent,
        skill,
        GrantPolicy(task, frozenset(json.loads(modes))),
        provider,
        Path(cwd),
        Path(inbox),
    )


def process_grant(
    grant_id: str,
    *,
    launch: Callable[[DelegationRequest, str, int, Path], str],
    request_paths: set[Path] | None = None,
) -> list[ProcessResult]:
    """Validate and launch each direct inbox file without sibling coupling."""
    sessions = _sessions_module()
    grant = _load_live_grant(grant_id)
    if not grant.inbox.is_dir() or grant.inbox.resolve() != grant.inbox:
        raise sessions.SessionError("the live skill grant inbox is missing or no longer canonical")
    results: list[ProcessResult] = []
    for path in sorted(grant.inbox.iterdir(), key=lambda item: item.name):
        if path.is_dir() and not path.is_symlink():
            continue
        if request_paths is not None and path.resolve() not in {candidate.resolve() for candidate in request_paths}:
            continue
        request_id = str(uuid.uuid4())
        try:
            request = parse_request_file(path, grant.inbox, grant.policy, parent_provider=grant.provider)
        except RequestFileError as exc:
            with sessions._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if connection.execute(
                    "SELECT 1 FROM requests WHERE grant_id = ? AND source_name = ?",
                    (grant.id, path.name),
                ).fetchone() is not None:
                    connection.rollback()
                    continue
                agent_number = connection.execute(
                    "SELECT COALESCE(MAX(agent_number), 0) + 1 FROM requests WHERE parent_session_id = ?",
                    (grant.parent_session_id,),
                ).fetchone()[0]
                connection.execute(
                    """
                    INSERT INTO requests(
                        id, parent_session_id, grant_id, agent_number, source_name,
                        state, reason, delivery_id
                    ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)
                    """,
                    (
                        request_id, grant.parent_session_id, grant.id, agent_number,
                        path.name, str(exc), str(uuid.uuid4()),
                    ),
                )
                connection.execute("UPDATE grants SET state = 'used' WHERE id = ? AND state = 'open'", (grant.id,))
                connection.commit()
            results.append(ProcessResult(path, "failed", request_id=request_id, reason=str(exc)))
            continue
        digest = hashlib.sha256(request.prompt.encode("utf-8")).hexdigest()
        with sessions._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute(
                "SELECT 1 FROM requests WHERE grant_id = ? AND source_name = ?",
                (grant.id, path.name),
            ).fetchone() is not None:
                connection.rollback()
                continue
            agent_number = connection.execute(
                "SELECT COALESCE(MAX(agent_number), 0) + 1 FROM requests WHERE parent_session_id = ?",
                (grant.parent_session_id,),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO requests(
                    id, parent_session_id, grant_id, agent_number, source_name,
                    task, provider, mode, prompt_hash, state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching')
                """,
                (
                    request_id, grant.parent_session_id, grant.id, agent_number, path.name,
                    request.task, request.provider, request.mode, digest,
                ),
            )
            connection.execute("UPDATE grants SET state = 'used' WHERE id = ? AND state = 'open'", (grant.id,))
            connection.commit()
        try:
            child_id = launch(request, request_id, agent_number, grant.original_cwd)
        except Exception as exc:
            with sessions._connect() as connection:
                connection.execute(
                    """
                    UPDATE requests SET state = 'failed', reason = ?, delivery_id = ?
                    WHERE id = ? AND state = 'launching'
                    """,
                    ("launch failed", str(uuid.uuid4()), request_id),
                )
            results.append(ProcessResult(path, "failed", request_id=request_id, reason="launch failed"))
            continue
        with sessions._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO sessions(
                    id, claude_session_id, cwd, provider, execution_mode
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (child_id, child_id, str(grant.original_cwd), request.provider, request.mode),
            )
            connection.execute(
                "UPDATE sessions SET provider = ?, execution_mode = ?, cwd = ? WHERE id = ?",
                (request.provider, request.mode, str(grant.original_cwd), child_id),
            )
            changed = connection.execute(
                "UPDATE requests SET child_session_id = ?, state = 'pending' WHERE id = ? AND state = 'launching'",
                (child_id, request_id),
            )
            if changed.rowcount != 1:
                raise sessions.SessionError("request launch state changed unexpectedly")
        results.append(ProcessResult(path, "launched", request_id, child_id))
    return results


def _next_sequence(connection, session_id: str) -> int:
    connection.execute(
        "UPDATE sessions SET hook_sequence = hook_sequence + 1 WHERE id = ?",
        (session_id,),
    )
    row = connection.execute("SELECT hook_sequence FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise _sessions_module().SessionError(f"unknown Harness session {session_id}")
    return int(row[0])


def arm_reply(child_session_id: str) -> None:
    sessions = _sessions_module()
    with sessions._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT id FROM requests WHERE child_session_id = ? AND mode = 'interactive' AND state = 'pending'",
            (child_session_id,),
        ).fetchone()
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
) -> bool:
    """Resolve an auto request or consume an interactive one-shot reply."""
    with _sessions_module()._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT id, mode, state FROM requests WHERE child_session_id = ?",
            (child_session_id,),
        ).fetchone()
        if row is None or row[2] != "pending":
            connection.rollback()
            return False
        request_id, mode, _state = row
        if mode == "interactive":
            if cancelled:
                connection.execute("DELETE FROM reply_authorizations WHERE request_id = ?", (request_id,))
            else:
                authorization = connection.execute(
                    "SELECT 1 FROM reply_authorizations WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if authorization is None:
                    connection.rollback()
                    return False
                connection.execute("DELETE FROM reply_authorizations WHERE request_id = ?", (request_id,))
                if not success:
                    connection.commit()
                    return False
        state = "succeeded" if success else ("cancelled" if cancelled else "failed")
        delivery_id = str(uuid.uuid4())
        changed = connection.execute(
            """
            UPDATE requests SET state = ?, reply = ?, reason = ?, delivery_id = ?
            WHERE id = ? AND state = 'pending'
            """,
            (state, message if success else None, reason, delivery_id, request_id),
        )
        connection.commit()
        return changed.rowcount == 1


def observe_parent_event(parent_session_id: str, event: str) -> None:
    if event not in {"PreToolUse", "Stop"}:
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
        connection.commit()


def _running_count(connection, parent_session_id: str) -> int:
    return int(connection.execute(
        "SELECT count(*) FROM requests WHERE parent_session_id = ? AND state IN ('launching', 'pending')",
        (parent_session_id,),
    ).fetchone()[0])


def _format_results(rows, running: int) -> str:
    messages: list[str] = []
    for row in rows:
        _request_id, number, state, reply, reason, _delivery_id = row[:6]
        if state == "succeeded":
            messages.append(f"Agent {number} finished. Agent replied:\n\n{reply}")
        elif state == "cancelled":
            messages.append(f"Agent {number} was cancelled.")
        else:
            messages.append(f"Agent {number} failed: {reason or 'unknown failure'}.")
    noun = "agent" if running == 1 else "agents"
    messages.append(f"{running} {noun} still running.")
    return "\n\n".join(messages)


def claim_parent_delivery(parent_session_id: str, event: str) -> ParentDelivery | None:
    """Claim ready results, replaying the same claim until a later acknowledgement."""
    with _sessions_module()._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        sequence = _next_sequence(connection, parent_session_id)
        state_filter = (
            "AND state IN ('succeeded', 'failed', 'cancelled')"
            if event == "UserPromptSubmit"
            else "AND state = 'succeeded'"
        )
        rows = connection.execute(
            f"""
            SELECT id, agent_number, state, reply, reason, delivery_id, claim_sequence
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
        text = _format_results(selected, _running_count(connection, parent_session_id))
        connection.commit()
        return ParentDelivery(delivery_id, text)


def has_pending_children(parent_session_id: str) -> bool:
    with _sessions_module()._connect() as connection:
        return connection.execute(
            "SELECT 1 FROM requests WHERE parent_session_id = ? AND state IN ('launching', 'pending') LIMIT 1",
            (parent_session_id,),
        ).fetchone() is not None


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
        if not has_pending_children(parent_session_id) or time.monotonic() >= deadline:
            return None
        time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))


def close_parent_grants(parent_session_id: str, *, include_open: bool = False) -> None:
    """Close used grants, or every grant when the parent session itself ends."""
    sessions = _sessions_module()
    states = ("open", "used") if include_open else ("used",)
    placeholders = ", ".join("?" for _ in states)
    parameters = (parent_session_id, *states)
    with sessions._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            f"SELECT id, original_cwd, inbox FROM grants WHERE parent_session_id = ? AND state IN ({placeholders})",
            parameters,
        ).fetchall()
        connection.execute(
            f"UPDATE grants SET state = 'closed', closed_at = CURRENT_TIMESTAMP WHERE parent_session_id = ? AND state IN ({placeholders})",
            parameters,
        )
        connection.commit()
    for _grant_id, cwd, inbox_value in rows:
        inbox = Path(inbox_value)
        expected = Path(cwd).resolve() / ".harness" / "runtime" / "sessions" / parent_session_id
        try:
            grant_root = inbox.resolve().parent
            grant_root.relative_to(expected)
        except (OSError, ValueError):
            continue
        shutil.rmtree(grant_root, ignore_errors=True)
