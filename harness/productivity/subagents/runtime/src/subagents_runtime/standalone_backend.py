"""Native CLI process execution, independent of optional terminal hosts."""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from subagents_runtime.storage import connect, state_dir


class StandaloneBackend:
    name = "standalone"
    supports_live_continuation = False

    def progress_path(self, execution_id: str, owner_id: str) -> Path:
        return state_dir() / "runtime" / "sessions" / owner_id / "executions" / execution_id / "stdout.jsonl"

    def probe(self, request, cwd: Path) -> bool:
        return True

    def launch(self, request, request_id: str, agent_number: int, cwd: Path) -> str:
        from subagents_runtime import processes, sessions
        with connect() as db:
            row = db.execute(
                "SELECT r.child_session_id,e.id,s.provider_session_id,e.fork_of FROM requests r JOIN executions e ON e.request_id=r.id JOIN sessions s ON s.id=r.child_session_id WHERE r.id=?",
                (request_id,),
            ).fetchone()
        if row is None:
            raise sessions.SessionError("Delegated launch requires a persisted execution reservation")
        child_id, execution_id, conversation, fork_of = row
        skill = getattr(request, "child_skill", None)
        environment = os.environ.copy()
        environment.update({
            "HARNESS_SESSION_ID": child_id, "HARNESS_REQUEST_ID": request_id,
            "HARNESS_EXECUTION_ID": execution_id, "HARNESS_EXECUTION_MODE": request.mode,
            "HARNESS_PROVIDER": request.provider,
        })
        environment.pop("HARNESS_REPLY_REQUIRED", None)
        if request.mode == "interactive":
            environment["HARNESS_REPLY_REQUIRED"] = "1"
        if request.provider == "claude" and request.mode in {"interactive", "loop"}:
            environment.pop("CLAUDE_CODE_CHILD_SESSION", None)
        runtime_root = str(Path(__file__).resolve().parent.parent)
        environment["PYTHONPATH"] = runtime_root + os.pathsep + environment.get("PYTHONPATH", "")
        if request.mode == "loop" and request.resume:
            with connect() as db:
                previous = db.execute(
                    "SELECT 1 FROM executions WHERE session_id=? AND superseded_at IS NOT NULL "
                    "AND backend!='standalone' AND state IN ('running','starting','uncertain') LIMIT 1",
                    (child_id,),
                ).fetchone()
            if previous:
                raise sessions.SessionError("The runtime is unavailable for the live released implementer; launch a fresh implementer instead")
        config = sessions.launch_configuration(cwd)
        options = sessions._launch_options(config, request, cwd)
        command = sessions._provider_command(config, request.provider)
        if fork_of:
            forked = str(uuid.uuid4()) if request.provider in sessions._ASSIGNED_IDENTITY else None
            with connect() as db:
                db.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (forked, child_id))
            command.extend(sessions.provider_arguments(
                request.provider, request.mode, fork_of, request.prompt,
                fork=True, fork_id=forked, launch_options=options,
            ))
        else:
            continuing = bool(request.resume)
            if continuing or skill is None:
                prompt = request.prompt
            elif request.provider == "pi":
                prompt = f"/skill:{skill} {request.prompt}"
            else:
                prompt = f"{'$' if request.provider == 'chatgpt' else '/'}{skill}\n\n{request.prompt}"
            if not continuing and request.provider in sessions._ASSIGNED_IDENTITY:
                conversation = child_id
                if request.provider == "pi":
                    with connect() as db:
                        db.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (child_id, child_id))
                command.extend(["--name", f"agent-{agent_number}"])
            command.extend(sessions.provider_arguments(
                request.provider, request.mode, conversation, prompt,
                resume=continuing, launch_options=options,
            ))
        processes.start(execution_id, command, environment, cwd, visible=request.mode in {"interactive", "loop"})
        return child_id
