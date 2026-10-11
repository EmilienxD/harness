"""Standalone visible-terminal sessions and durable ask/reply relationships."""

from __future__ import annotations

import json
import math
import os
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


class SessionError(RuntimeError):
    pass


from subagents_runtime.storage import connect as _connect
from subagents_runtime.storage import state_dir

_CLAUDE_MODELS = frozenset({"haiku", "sonnet", "opus"})
_CLAUDE_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_CHATGPT_EFFORTS = frozenset({"minimal", "low", "medium", "high", "xhigh"})
DIFFICULTIES = ("routine", "basic", "advanced", "expert")
_DIFFICULTY_PROFILES = {
    "claude": (("haiku", "medium"), ("sonnet", "high"), ("opus", "medium"), ("opus", "high")),
    "chatgpt": (("gpt-5.6-luna", "medium"), ("gpt-5.6-terra", "high"), ("gpt-5.6-sol", "medium"), ("gpt-5.6-sol", "high")),
}


def loop_configuration(config: dict[str, Any]) -> dict[str, int | float]:
    """Validated loop limits; omitted fields use the product defaults."""
    value = config.get("loop", {})
    if not isinstance(value, dict):
        raise SessionError("loop must be a JSON object")
    limits = {"maxFeedback": 3, "maxImplementers": 2, "freshContextPercent": 65}
    for key, default in limits.items():
        selected = value.get(key, default)
        if key == "freshContextPercent":
            valid = isinstance(selected, (int, float)) and not isinstance(selected, bool) and math.isfinite(selected) and 0 <= selected <= 100
        else:
            valid = isinstance(selected, int) and not isinstance(selected, bool) and selected >= (1 if key == "maxImplementers" else 0)
        if not valid:
            raise SessionError(f"loop.{key} is invalid")
        limits[key] = selected
    return limits


def _config() -> dict[str, Any]:
    path = state_dir() / "config.json"
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionError(f"invalid Harness config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SessionError(f"Harness config {path} must be a JSON object")
    return value


def launch_configuration(cwd: Path) -> dict[str, Any]:
    """Resolve the project, global, then built-in launch configuration."""
    project = cwd.resolve() / ".harness" / "config.json"
    global_path = state_dir() / "config.json"
    for path in (project, global_path):
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SessionError(
                f"invalid Harness configuration {path}: {exc}"
            ) from exc
        if not isinstance(value, dict) or value.get("version") != 1:
            raise SessionError(
                f"Harness configuration {path} must be a version-1 JSON object"
            )
        auto_run = value.get("autoRun", {})
        providers = value.get("providers", {})
        if not isinstance(auto_run, dict) or (
            "provider" in auto_run
            and auto_run.get("provider") not in {"claude", "chatgpt"}
        ):
            raise SessionError(
                f"Harness configuration {path} autoRun.provider must be claude or chatgpt"
            )
        if not isinstance(providers, dict) or any(
            name in providers and not isinstance(providers[name], dict)
            for name in ("claude", "chatgpt")
        ):
            raise SessionError(
                f"Harness configuration {path} providers must contain JSON objects"
            )
        session = value.get("session", {})
        if not isinstance(session, dict):
            raise SessionError(
                f"Harness configuration {path} session must be a JSON object"
            )
        stop_wait = session.get("stopWaitHours")
        if stop_wait is not None and (
            isinstance(stop_wait, bool)
            or not isinstance(stop_wait, (int, float))
            or not math.isfinite(stop_wait)
            or stop_wait < 0
        ):
            raise SessionError(
                f"Harness configuration {path} session.stopWaitHours must be a non-negative finite number"
            )
        loop_configuration(value)
        return value
    return {"version": 1}


def _split_command(value: str) -> list[str]:
    if os.name != "nt":
        return shlex.split(value)
    # posix=False preserves Windows path separators, but also preserves the
    # quotes around a token. Popen expects the unquoted argv value.
    return [
        token[1:-1]
        if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'"
        else token
        for token in shlex.split(value, posix=False)
    ]


def _command(value: object, setting: str) -> list[str]:
    command = _split_command(value) if isinstance(value, str) else value
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) and part.strip() for part in command)
    ):
        raise SessionError(
            f"{setting} must be a non-empty string or array of non-empty strings"
        )
    # Arrays are argv, not a shell-ish representation. Preserve each token
    # byte-for-byte after validation; spaces can be intentional inside one arg.
    return list(command)


def _command_from_config(config: dict[str, Any], provider: str) -> list[str]:
    setting = f"providers.{provider}.command"
    providers = config.get("providers", {})
    provider_config = providers.get(provider, {}) if isinstance(providers, dict) else {}
    command = provider_config.get(
        "command", ["codex"] if provider == "chatgpt" else ["claude"]
    )
    command = _command(command, setting)
    executable = Path(command[0]).expanduser()
    if shutil.which(command[0]) is None and not executable.is_file():
        raise SessionError(f"{provider} command is not available: {command[0]}")
    return command


def _provider_command(config: dict[str, Any], provider: str) -> list[str]:
    return _command_from_config(config, provider)


def delegation_profile_arguments(
    config: dict[str, Any], provider: str, task: str, *, difficulty: str | None = None,
    model_override: str | None = None,
) -> list[str]:
    """Resolve one manual task without coupling it to another launch profile."""
    providers = config.get("providers", {})
    provider_config = providers.get(provider, {}) if isinstance(providers, dict) else {}
    delegations = provider_config.get("delegations", {})
    if not isinstance(delegations, dict):
        raise SessionError(f"providers.{provider}.delegations must be a JSON object")
    selected = delegations.get(task, {})
    if not isinstance(selected, dict):
        raise SessionError(
            f"providers.{provider}.delegations.{task} must be a JSON object"
        )
    if provider == "chatgpt" and task == "explore":
        model, effort = "gpt-5.6-luna", "low"
    elif provider == "claude" and task == "explore":
        model, effort = "haiku", "low"
    else:
        model = effort = None
    model = selected.get("model", model)
    effort = selected.get("effort", effort)
    if difficulty is not None and difficulty not in DIFFICULTIES:
        raise SessionError(f"unsupported difficulty {difficulty!r}")
    if model == "by-difficulty":
        model, routed_effort = _DIFFICULTY_PROFILES[provider][DIFFICULTIES.index(difficulty or "expert")]
        if "effort" not in selected:
            effort = routed_effort
    if model_override is not None:
        model = model_override
    model = None if model == "inherit" else model
    effort = None if effort == "inherit" else effort
    model_invalid = (
        model is not None
        and (
            not isinstance(model, str)
            or not model.strip()
            or (provider == "claude" and model not in _CLAUDE_MODELS and not model.startswith("claude-"))
            or (
                provider == "chatgpt"
                and (model in _CLAUDE_MODELS or model.startswith("claude-"))
            )
        )
    )
    if model_invalid:
        raise SessionError(
            f"providers.{provider}.delegations.{task}.model is not valid for {provider}"
        )
    effort_invalid = effort is not None and (
        not isinstance(effort, str)
        or effort
        not in (_CLAUDE_EFFORTS if provider == "claude" else _CHATGPT_EFFORTS)
    )
    if effort_invalid:
        raise SessionError(
            f"providers.{provider}.delegations.{task}.effort is not valid for {provider}"
        )
    arguments: list[str] = []
    if provider == "claude":
        denied_tools = selected.get("deniedTools", [])
        if task == "explore" and "deniedTools" in selected:
            raise SessionError(
                f"providers.{provider}.delegations.{task}.deniedTools is not supported"
            )
        if not isinstance(denied_tools, list) or not all(
            isinstance(rule, str) and rule.strip() for rule in denied_tools
        ):
            raise SessionError(
                f"providers.{provider}.delegations.{task}.deniedTools must be an array of non-empty strings"
            )
        if denied_tools:
            arguments.extend(
                ["--disallowedTools", ",".join(dict.fromkeys(denied_tools))]
            )
    if model is not None:
        arguments.extend(["--model", model])
    if effort is not None:
        arguments.extend(
            ["--effort", effort]
            if provider == "claude"
            else ["-c", f"model_reasoning_effort={json.dumps(effort)}"]
        )
    return arguments


def _harness_environment(environment: dict[str, str]) -> dict[str, str]:
    """Values a separately launched terminal cannot safely be assumed to inherit."""
    return {
        key: value for key, value in environment.items() if key.startswith("HARNESS_")
    }


def _powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _powershell_command(argv: list[str]) -> str:
    return "& " + " ".join(_powershell_literal(part) for part in argv)


def _macos_terminal_command(
    argv: list[str], environment: dict[str, str], cwd: Path
) -> str:
    exported = [
        "env",
        *(f"{key}={value}" for key, value in _harness_environment(environment).items()),
        *argv,
    ]
    return f"cd {shlex.quote(str(cwd))} && {shlex.join(exported)}"


def _apple_script_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _visible_terminal(argv: list[str], environment: dict[str, str], cwd: Path) -> None:
    config = _config()
    explicit = config.get("terminalCommand")
    if explicit is not None:
        prefix = _command(explicit, "terminalCommand")
        subprocess.Popen(
            [*prefix, *argv], env=environment, cwd=cwd, start_new_session=True
        )
        return

    tried: list[str] = []
    if os.name == "nt":
        tried.append("Windows Terminal (wt.exe)")
        if terminal := shutil.which("wt.exe"):
            subprocess.Popen(
                [terminal, "new-tab", "--", *argv], env=environment, cwd=cwd
            )
            return
        tried.append("Windows console (powershell.exe)")
        if shell := shutil.which("powershell.exe"):
            flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            subprocess.Popen(
                [shell, "-NoExit", "-Command", _powershell_command(argv)],
                env=environment,
                cwd=cwd,
                creationflags=flags,
            )
            return
    elif sys.platform == "darwin":
        tried.append("Terminal.app (osascript)")
        if script := shutil.which("osascript"):
            command = _apple_script_literal(
                _macos_terminal_command(argv, environment, cwd)
            )
            subprocess.Popen(
                [script, "-e", f'tell application "Terminal" to do script "{command}"'],
                cwd=cwd,
                start_new_session=True,
            )
            return
    else:
        candidates = (
            ("x-terminal-emulator", ["-e"]),
            ("gnome-terminal", ["--"]),
            ("konsole", ["-e"]),
            ("xterm", ["-e"]),
        )
        for name, args in candidates:
            tried.append(name)
            if terminal := shutil.which(name):
                subprocess.Popen(
                    [terminal, *args, *argv],
                    env=environment,
                    cwd=cwd,
                    start_new_session=True,
                )
                return
    raise SessionError("could not open a visible terminal; tried: " + ", ".join(tried))


def _register(
    session_id: str,
    cwd: Path,
    provider: str,
    execution_mode: str = "interactive",
) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT INTO sessions(id, provider_session_id, cwd, provider, execution_mode) VALUES (?, ?, ?, ?, ?)",
            (
                session_id,
                session_id if provider == "claude" else None,
                str(cwd.resolve()),
                provider,
                execution_mode,
            ),
        )


def register_observed(
    session_id: str,
    cwd: Path,
    provider: str,
    execution_mode: str = "interactive",
) -> None:
    if provider not in {"claude", "chatgpt"}:
        raise SessionError(f"unsupported provider {provider!r}")
    if execution_mode not in {"interactive", "auto", "auto-run", "loop"}:
        raise SessionError(f"unsupported execution mode {execution_mode!r}")
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO sessions(id, provider_session_id, cwd, provider, execution_mode)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                provider = sessions.provider
            """,
            (session_id, session_id, str(cwd.resolve()), provider, execution_mode),
        )


def bind_observed(
    runtime_session_id: str,
    cwd: Path,
    provider: str,
    execution_mode: str = "interactive",
) -> str:
    """Bind a runtime-assigned provider id to the stable Harness identity."""
    stable_id = os.environ.get("HARNESS_SESSION_ID")
    with _connect() as connection:
        bound = connection.execute(
            "SELECT id FROM sessions WHERE provider=? AND provider_session_id=?",
            (provider, runtime_session_id),
        ).fetchone()
        if bound:
            return bound[0]
        if (
            stable_id
            and connection.execute(
                "SELECT 1 FROM sessions WHERE id=? AND (provider_session_id IS NULL OR provider_session_id=?)",
                (stable_id, runtime_session_id),
            ).fetchone()
        ):
            connection.execute(
                "UPDATE sessions SET provider_session_id=? WHERE id=?",
                (runtime_session_id, stable_id),
            )
            return stable_id
    register_observed(runtime_session_id, cwd, provider, execution_mode)
    return runtime_session_id


def launch(prompt: str | None = None, cwd: Path | None = None, *, provider: str) -> str:
    from subagents_runtime import processes

    session_id = str(uuid.uuid4())
    execution_id = str(uuid.uuid4())
    selected_cwd = (cwd or Path.cwd()).resolve()
    command = [
        *_provider_command(launch_configuration(selected_cwd), provider),
        *provider_arguments(
            provider,
            "interactive",
            session_id if provider == "claude" else None,
            prompt,
        ),
    ]
    _register(session_id, selected_cwd, provider)
    with _connect() as connection:
        connection.execute(
            "INSERT INTO executions(id,session_id,backend,state) VALUES (?,?,'standalone','prepared')",
            (execution_id, session_id),
        )
    environment = os.environ.copy()
    environment.update(
        {
            "HARNESS_SESSION_ID": session_id,
            "HARNESS_EXECUTION_ID": execution_id,
            "HARNESS_PROVIDER": provider,
            "HARNESS_EXECUTION_MODE": "interactive",
        }
    )
    environment["PYTHONPATH"] = (
        str(Path(__file__).resolve().parent.parent)
        + os.pathsep
        + environment.get("PYTHONPATH", "")
    )
    processes.start(execution_id, command, environment, selected_cwd, visible=True)
    return session_id


def provider_arguments(
    provider: str,
    mode: str,
    conversation: str | None,
    prompt: str | None,
    *,
    resume: bool = False,
    fork: bool = False,
    fork_id: str | None = None,
    launch_options: list[str] | None = None,
) -> list[str]:
    """Native provider arguments, with permissions supplied by native configuration.

    A fork continues a copy of the conversation, which is the only way to carry a
    transcript forward while its original session is still open somewhere else.
    """
    arguments = []
    if provider == "claude":
        if mode not in {"interactive", "loop"}:
            arguments.extend(["-p", "--output-format", "stream-json", "--verbose"])
        if fork:
            arguments.extend(["--resume", conversation, "--fork-session"])
            if fork_id:
                arguments.extend(["--session-id", fork_id])
        elif conversation:
            arguments.extend(["--resume" if resume else "--session-id", conversation])
    elif mode not in {"interactive", "loop"}:
        arguments.extend(["exec"])
        if fork or resume:
            arguments.extend(["fork" if fork else "resume", conversation])
        arguments.append("--json")
    elif fork or resume:
        arguments.extend(["fork" if fork else "resume", conversation])
    arguments.extend(launch_options or [])
    if prompt:
        arguments.append("--")
        arguments.append(prompt)
    return arguments


def launch_delegated(request, request_id: str, agent_number: int, cwd: Path) -> str:
    from subagents_runtime import processes
    from subagents_runtime.roles import find_skill

    with _connect() as connection:
        row = connection.execute(
            "SELECT r.child_session_id,e.id,s.provider_session_id,e.fork_of FROM requests r JOIN executions e ON e.request_id=r.id JOIN sessions s ON s.id=r.child_session_id WHERE r.id=?",
            (request_id,),
        ).fetchone()
    if row is None:
        raise SessionError(
            "Delegated launch requires a persisted execution reservation"
        )
    child_id, execution_id, conversation, fork_of = row
    skill = getattr(request, "child_skill", None)
    if not request.resume and skill and find_skill(cwd, request.provider, skill) is None:
        raise SessionError(f"Child skill {skill!r} is unavailable for {request.provider} in {cwd}; install it before launching task {request.task!r}")
    environment = os.environ.copy()
    environment.update(
        {
            "HARNESS_SESSION_ID": child_id,
            "HARNESS_REQUEST_ID": request_id,
            "HARNESS_EXECUTION_ID": execution_id,
            "HARNESS_EXECUTION_MODE": request.mode,
            "HARNESS_PROVIDER": request.provider,
        }
    )
    if request.provider == "claude" and request.mode in {"interactive", "loop"}:
        # Claude exports this marker to commands it starts. An interactive Harness
        # child is a separately resumable conversation, so inheriting the marker
        # would make Claude suppress its transcript and break the next --resume.
        environment.pop("CLAUDE_CODE_CHILD_SESSION", None)
    # The supervisor itself is importable when executing directly from a checkout.
    runtime_root = str(Path(__file__).resolve().parent.parent)
    environment["PYTHONPATH"] = (
        runtime_root + os.pathsep + environment.get("PYTHONPATH", "")
    )
    if request.mode == "loop" and request.provider == "chatgpt":
        from subagents_runtime.codex_trust import trust_worktree
        trust_worktree(cwd)
    if aboard_session := _launch_through_aboard(request, request_id, cwd):
        with _connect() as connection:
            connection.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (aboard_session, child_id))
            connection.execute("UPDATE executions SET backend='aboard' WHERE id=?", (execution_id,))
        processes.confirm_startup(execution_id)
        return child_id
    if request.mode == "loop" and request.resume:
        with _connect() as connection:
            previous = connection.execute(
                "SELECT 1 FROM executions WHERE session_id=? AND superseded_at IS NOT NULL "
                "AND backend='aboard' AND state IN ('running','starting','uncertain') LIMIT 1",
                (child_id,),
            ).fetchone()
        if previous:
            raise SessionError("Aboard is unavailable for the live released implementer; launch a fresh implementer instead")
    if fork_of:
        # The original session is still open and still owns its provider handle, so a
        # fork starts its own process here and takes over the child's identity.
        forked = str(uuid.uuid4()) if request.provider == "claude" else None
        with _connect() as connection:
            connection.execute(
                "UPDATE sessions SET provider_session_id=? WHERE id=?", (forked, child_id)
            )
        launch_config = launch_configuration(cwd)
        command = [
            *_provider_command(launch_config, request.provider),
            *provider_arguments(
                request.provider,
                request.mode,
                fork_of,
                request.prompt,
                fork=True,
                fork_id=forked,
                launch_options=delegation_profile_arguments(
                    launch_config, request.provider, request.task, difficulty=getattr(request, "difficulty", None),
                    model_override=getattr(request, "model", None),
                ),
            ),
        ]
        processes.start(
            execution_id,
            command,
            environment,
            cwd,
            visible=request.mode in {"interactive", "loop"},
        )
        return child_id
    continuing = bool(request.resume)
    prompt = (
        request.prompt
        if continuing or skill is None
        else f"{'$' if request.provider == 'chatgpt' else '/'}{skill}\n\n{request.prompt}"
    )
    if not continuing and request.provider == "claude":
        conversation = child_id
    launch_config = launch_configuration(cwd)
    command = _provider_command(launch_config, request.provider)
    if not continuing and request.provider == "claude":
        command.extend(["--name", f"agent-{agent_number}"])
    command.extend(
        provider_arguments(
            request.provider,
            request.mode,
            conversation,
            prompt,
            resume=continuing,
            launch_options=delegation_profile_arguments(
                launch_config, request.provider, request.task, difficulty=getattr(request, "difficulty", None),
                model_override=getattr(request, "model", None),
            ),
        )
    )
    processes.start(
        execution_id, command, environment, cwd, visible=request.mode in {"interactive", "loop"}
    )
    return child_id


def _endpoint_directory() -> Path:
    if os.name == "nt":
        return (
            Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
            / "abd"
            / "endpoints"
        )
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "abd" / "endpoints"
    return (
        Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
        / "abd"
        / "endpoints"
    )


def _path_contains(root: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _process_alive(pid: int) -> bool:
    from subagents_runtime.processes import process_alive

    return process_alive(pid)


def _registered_worktree(root: Path, cwd: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "worktree", "list", "--porcelain", "-z"],
            capture_output=True, check=True, timeout=10,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
        return any(
            Path(os.fsdecode(field[9:])).resolve() == cwd.resolve()
            for field in result.stdout.split(b"\0") if field.startswith(b"worktree ")
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _discover_delegation_endpoint(cwd: Path, *, include_worktrees: bool = False) -> tuple[str, int, str] | None:
    inherited_port = os.environ.get("ABOARD_BRIDGE_PORT")
    inherited_token = os.environ.get("ABOARD_BRIDGE_TOKEN")
    if inherited_port is not None or inherited_token is not None:
        if not inherited_port or not inherited_token:
            raise SessionError("inherited Aboard authentication is incomplete")
        try:
            return "127.0.0.1", int(inherited_port), inherited_token
        except ValueError as exc:
            raise SessionError("inherited Aboard bridge port is invalid") from exc
    directory = _endpoint_directory()
    try:
        entries = list(directory.glob("*.json"))
    except OSError:
        return None
    candidates: list[tuple[str, int, str, str]] = []
    for path in entries:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if (
                record.get("version") == 2
                and record.get("host") == "127.0.0.1"
                and isinstance(record.get("port"), int)
                and isinstance(record.get("delegationToken"), str)
                and isinstance(record.get("workspaceRoot"), str)
                and isinstance(record.get("pid"), int)
                and _process_alive(record["pid"])
                and (_path_contains(Path(record["workspaceRoot"]), cwd)
                     or (include_worktrees and _registered_worktree(Path(record["workspaceRoot"]), cwd)))
            ):
                candidates.append(
                    (
                        record["host"],
                        record["port"],
                        record["delegationToken"],
                        str(record.get("activatedAt", "")),
                    )
                )
        except (OSError, ValueError, TypeError):
            continue
    if not candidates:
        return None
    host, port, token, _activated = max(candidates, key=lambda item: item[3])
    return host, port, token


def _aboard_error(exc: urllib.error.HTTPError) -> tuple[str | None, str]:
    """The bridge's own words for a refusal, so a caller never has to guess."""
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None, ""
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return None, ""
    code = error.get("code")
    message = error.get("message")
    return (
        code if isinstance(code, str) else None,
        message if isinstance(message, str) else "",
    )


def _launch_through_aboard(request, request_id: str, cwd: Path) -> str | None:
    from subagents_runtime.roles import builtin_toolkit, read_task_policies

    # Aboard's bridge currently accepts only the shipped tasks and child skills.
    # Project roles use the native adapter with their named task and provider profile.
    bridge_contract = json.loads(
        (Path(__file__).parent / "schemas" / "aboard-delegation.schema.json").read_text(encoding="utf-8")
    )
    if request.task not in bridge_contract["properties"]["task"]["enum"]:
        return None
    builtin = next((policy for policy in read_task_policies(builtin_toolkit()).values()
                    if policy.task == request.task), None)
    if request.task != "loop" and (
        builtin is None or (
            not getattr(request, "resume", None)
            and getattr(request, "child_skill", builtin.skill) != builtin.skill
        )
    ):
        return None
    def discover():
        return (_discover_delegation_endpoint(cwd, include_worktrees=True)
                if request.mode == "loop" else _discover_delegation_endpoint(cwd))
    endpoint = discover()
    if endpoint is None:
        return None
    with _connect() as connection:
        reservation = connection.execute(
            "SELECT r.child_session_id,e.id,r.parent_session_id,s.provider_session_id,e.fork_of FROM requests r JOIN executions e ON e.request_id=r.id JOIN sessions s ON s.id=r.child_session_id WHERE r.id=?",
            (request_id,),
        ).fetchone()
        previous = (
            connection.execute(
                "SELECT aboard_agent_id FROM executions WHERE session_id=? AND aboard_agent_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
                (reservation[0],),
            ).fetchone()
            if reservation
            else None
        )
    identities = (
        {}
        if reservation is None
        else {
            "harnessSessionId": reservation[0],
            "executionId": reservation[1],
            "parentSessionId": reservation[2],
            "harnessStateDirectory": str(state_dir()),
            "harnessRuntimePath": str(Path(__file__).resolve().parent.parent),
            "harnessPython": sys.executable,
        }
    )
    if getattr(request, "resume", None):
        if not previous:
            raise SessionError("Aboard child handle is unavailable; resume refused")
        identities.update(
            {"resumeAgentId": previous[0], "resumeSessionId": reservation[3]}
        )
        if reservation[4]:
            identities["forkSessionId"] = reservation[4]
    if reservation:
        with _connect() as connection:
            if reservation[4]:
                # The fork receives a new provider conversation ID in SessionStart.
                # Release the old binding before its hooks attempt to bind that ID.
                connection.execute("UPDATE sessions SET provider_session_id=NULL WHERE id=?", (reservation[0],))
            connection.execute(
                "UPDATE executions SET state='starting',backend='aboard' WHERE id=?",
                (reservation[1],),
            )
    body = json.dumps(
        {
            **identities,
            "requestId": request_id,
            "task": request.task,
            "provider": request.provider,
            "mode": request.mode,
            **({"model": request.model} if getattr(request, "model", None) is not None else {}),
            "prompt": request.prompt,
            "cwd": str(cwd.resolve()),
            **({"difficulty": request.difficulty} if getattr(request, "difficulty", None) else {}),
        }
    ).encode("utf-8")
    result = None
    for attempt in range(2):
        host, port, token = endpoint
        http_request = urllib.request.Request(
            f"http://{host}:{port}/delegations",
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 401 and attempt == 0 and not os.environ.get(
                "ABOARD_BRIDGE_TOKEN"
            ):
                refreshed = discover()
                if refreshed is None:
                    raise SessionError(
                        "Aboard delegation endpoint authentication expired"
                    ) from None
                endpoint = refreshed
                continue
            code, detail = _aboard_error(exc)
            if reservation and 400 <= exc.code < 500 and code != "startup-uncertain":
                # A refusal is a decision taken before anything started. Release the
                # reservation so the request fails definitively and can be retried.
                with _connect() as connection:
                    connection.execute(
                        "UPDATE executions SET state='prepared' WHERE id=? AND state='starting'",
                        (reservation[1],),
                    )
            raise SessionError(
                f"Aboard refused the delegation with HTTP {exc.code}"
                + (f": {detail}" if detail else "")
            ) from None
        except (OSError, ValueError) as exc:
            raise SessionError(
                "Aboard delegation endpoint could not launch the request"
            ) from exc
    session_id = result.get("sessionId") if isinstance(result, dict) else None
    if not isinstance(session_id, str) or not session_id:
        raise SessionError(
            "Aboard delegation endpoint returned an invalid launch result"
        )
    if reservation:
        with _connect() as connection:
            connection.execute(
                "UPDATE executions SET aboard_agent_id=?,aboard_handle=? WHERE id=?",
                (result.get("agentId"), result.get("terminalId"), reservation[1]),
            )
    return session_id


def resolve_session(identifier: str, parent_id: str | None = None) -> str:
    import re

    if re.fullmatch(r"agent-[1-9][0-9]*", identifier):
        parent_id = parent_id or os.environ.get("HARNESS_SESSION_ID")
        with _connect() as connection:
            row = connection.execute(
                "SELECT id FROM sessions WHERE parent_session_id=? AND agent_index=?",
                (parent_id, int(identifier[6:])),
            ).fetchone()
        if row is None:
            raise SessionError(f"unknown child {identifier} in the caller conversation")
        return row[0]
    return identifier


def resume(session_id: str, message: str | None = None) -> None:
    from subagents_runtime import processes

    session_id = resolve_session(session_id)
    with _connect() as connection:
        row = connection.execute(
            "SELECT provider_session_id,cwd,provider,execution_mode,parent_session_id,agent_index FROM sessions WHERE id=?",
            (session_id,),
        ).fetchone()
    if row is None:
        raise SessionError(f"unknown Harness session {session_id}")
    if not row[0]:
        raise SessionError("Provider conversation has not been bound; resume refused")
    if row[4]:
        # The owning conversation's inbox decides between a plain resume and a fork.
        if not message or not message.strip():
            raise SessionError(
                "Delegated continuations require a nonempty next message"
            )
        if (
            os.environ.get("HARNESS_SESSION_ID")
            and os.environ["HARNESS_SESSION_ID"] != row[4]
        ):
            raise SessionError(
                "Delegated resume must originate in the owning parent conversation"
            )
        from subagents_runtime.delegation import process_inbox

        with _connect() as connection:
            inbox = connection.execute(
                "SELECT inbox FROM session_delegation WHERE parent_session_id=?",
                (row[4],),
            ).fetchone()
        path = Path(inbox[0]) / (uuid.uuid4().hex + ".md")
        path.write_text(
            f"---\nresume: agent-{row[5]}\n---\n{message}", encoding="utf-8"
        )
        results = process_inbox(row[4], launch=launch_delegated, request_paths={path})
        if not results or results[-1].status != "launched":
            raise SessionError(
                results[-1].reason if results else "Resume request was not processed"
            )
        return
    processes.require_exited(session_id)
    command = [
        *_provider_command(launch_configuration(Path(row[1])), row[2]),
        *provider_arguments(row[2], row[3], row[0], message, resume=True),
    ]
    execution_id = str(uuid.uuid4())
    with _connect() as connection:
        connection.execute(
            "INSERT INTO executions(id,session_id,backend,state) VALUES (?,?,'standalone','prepared')",
            (execution_id, session_id),
        )
    environment = os.environ.copy()
    environment.update(
        {
            "HARNESS_SESSION_ID": session_id,
            "HARNESS_EXECUTION_ID": execution_id,
            "HARNESS_EXECUTION_MODE": row[3],
            "HARNESS_PROVIDER": row[2],
        }
    )
    environment["PYTHONPATH"] = (
        str(Path(__file__).resolve().parent.parent)
        + os.pathsep
        + environment.get("PYTHONPATH", "")
    )
    processes.start(
        execution_id,
        command,
        environment,
        Path(row[1]),
        visible=row[3] == "interactive",
    )
