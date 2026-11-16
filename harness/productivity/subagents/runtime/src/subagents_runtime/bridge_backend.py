"""Client for the optional versioned loopback execution-host protocol."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from subagents_runtime import execution_host
from subagents_runtime.storage import state_dir


def endpoint_directory() -> Path:
    return Path.home() / ".harness" / "backends" / "endpoints"


def _contains(root: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _registered_worktree(root: Path, cwd: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "worktree", "list", "--porcelain", "-z"],
            capture_output=True, check=True, timeout=10,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
        if not cwd.is_dir() or not any(
            _contains(Path(os.fsdecode(field[9:])), cwd)
            for field in result.stdout.split(b"\0") if field.startswith(b"worktree ")
        ):
            return False
        common = []
        for directory in (root, cwd):
            metadata = subprocess.run(
                ["git", "-C", str(directory), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                capture_output=True, check=True, timeout=10,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
            )
            common.append(Path(os.fsdecode(metadata.stdout).strip()).resolve())
        return common[0] == common[1]
    except (OSError, subprocess.SubprocessError):
        return False


def discover(cwd: Path, *, include_worktrees: bool = False, resume: bool = False) -> tuple[str, int, str] | None:
    from subagents_runtime.processes import process_alive
    from subagents_runtime.sessions import SessionError

    port = os.environ.get("HARNESS_BRIDGE_PORT")
    token = os.environ.get("HARNESS_BRIDGE_TOKEN")
    inherited = None
    if port is not None or token is not None:
        if not port or not token:
            raise SessionError("Inherited runtime authentication is incomplete")
        try:
            selected = int(port)
            if not 1 <= selected <= 65535:
                raise ValueError()
            inherited = ("127.0.0.1", selected, token)
            if not resume:
                return inherited
        except ValueError as exc:
            raise SessionError("Inherited runtime endpoint port is invalid") from exc
    candidates = []
    for path in endpoint_directory().glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            roots = record.get("workspaceRoots", [record.get("workspaceRoot")])
            if not isinstance(roots, list) or not roots or not all(isinstance(root, str) and Path(root).is_absolute() for root in roots):
                continue
            if (
                record.get("version") == 2
                and record.get("host") == "127.0.0.1"
                and type(record.get("port")) is int
                and 1 <= record["port"] <= 65535
                and isinstance(record.get("delegationToken"), str)
                and record["delegationToken"]
                and isinstance(record.get("workspaceRoot"), str)
                and type(record.get("pid")) is int
                and record["pid"] > 0
                and process_alive(record["pid"])
                and any(
                    isinstance(root, str) and Path(root).is_absolute()
                    and (_contains(Path(root), cwd)
                         or (include_worktrees and _registered_worktree(Path(root), cwd)))
                    for root in roots
                )
            ):
                candidates.append((str(record.get("activatedAt", "")), record["port"], record["delegationToken"]))
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    if inherited is not None:
        matching = [candidate for candidate in candidates if candidate[1] == inherited[1]]
        if matching:
            # The inherited credential may be stale; use the current scoped token.
            _, port, token = max(matching)
            return "127.0.0.1", port, token
    if not candidates:
        return None
    _, port, token = max(candidates)
    return "127.0.0.1", port, token


def _error(exc: urllib.error.HTTPError) -> tuple[str | None, str]:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None, ""
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return None, ""
    code, message = error.get("code"), error.get("message")
    return code if isinstance(code, str) else None, message if isinstance(message, str) else ""


class BridgeBackend:
    name = "bridge"
    supports_live_continuation = True

    def progress_path(self, execution_id: str, owner_id: str) -> Path:
        return state_dir() / "runtime" / "watch" / execution_id / "stdout.jsonl"

    def _discover(self, request, cwd: Path):
        options = {}
        if getattr(request, "resume", None):
            options.update(resume=True, include_worktrees=True)
        elif request.mode == "loop":
            options["include_worktrees"] = True
        return discover(cwd, **options)

    def probe(self, request, cwd: Path) -> bool:
        self.endpoint = self._discover(request, cwd)
        return self.endpoint is not None

    def launch(self, request, request_id: str, agent_number: int, cwd: Path) -> str:
        from subagents_runtime.sessions import SessionError

        def endpoint():
            return self._discover(request, cwd)

        selected = self.endpoint
        if selected is None:
            raise SessionError("Execution backend was not selected before launch")
        reserved = execution_host.reservation(request_id)
        child_id, execution_id = reserved.session_id, reserved.execution_id
        parent_id, conversation, fork_of = reserved.parent_session_id, reserved.conversation_id, reserved.fork_of
        identities = {
            "harnessSessionId": child_id, "executionId": execution_id,
            "parentSessionId": parent_id, "harnessStateDirectory": str(state_dir()),
            "harnessRuntimePath": str(Path(__file__).resolve().parent.parent),
            "harnessPython": sys.executable,
        }
        if request.resume:
            identities.update(resumeSessionId=conversation)
            if reserved.previous_agent_id:
                identities["resumeAgentId"] = reserved.previous_agent_id
            if fork_of:
                identities["forkSessionId"] = fork_of
        body = json.dumps({
            **identities, "requestId": request_id,
            **({"skill": request.child_skill} if getattr(request, "child_skill", None) and not request.resume else {}),
            "provider": request.provider, "mode": request.mode,
            **({"model": request.model} if getattr(request, "model", None) is not None else {}),
            **({"effort": request.effort} if getattr(request, "effort", None) is not None else {}),
            "prompt": request.prompt, "cwd": str(cwd.resolve()),
            **({"difficulty": request.difficulty} if getattr(request, "difficulty", None) else {}),
        }).encode("utf-8")
        execution_host.starting(execution_id, self.name, fork=bool(fork_of))
        result = None
        for attempt in range(2):
            host, port, token = selected
            http_request = urllib.request.Request(
                f"http://{host}:{port}/delegations", data=body,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST",
            )
            try:
                with urllib.request.urlopen(http_request, timeout=15) as response:
                    result = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 401 and attempt == 0 and (request.resume or not os.environ.get("HARNESS_BRIDGE_TOKEN")):
                    selected = endpoint()
                    if selected is None:
                        raise SessionError("The runtime's delegation authentication expired") from None
                    continue
                code, detail = _error(exc)
                if 400 <= exc.code < 500 and code != "startup-uncertain":
                    execution_host.rejected(execution_id)
                raise SessionError(f"The runtime refused the delegation with HTTP {exc.code}" + (f": {detail}" if detail else "")) from None
            except (OSError, ValueError) as exc:
                raise SessionError("The runtime could not launch the delegation request") from exc
        conversation = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(conversation, str) or not conversation:
            raise SessionError("The runtime returned an invalid delegation launch result")
        execution_host.bind(execution_id, conversation, result.get("agentId"), result.get("terminalId"))
        return child_id
