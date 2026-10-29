"""Standalone visible-terminal sessions and durable ask/reply relationships."""

from __future__ import annotations

import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from subagents_runtime.effort import EFFORT_LEVELS, resolve_effort


class SessionError(RuntimeError):
    pass


from subagents_runtime.storage import connect as _connect
from subagents_runtime.storage import state_dir

PROVIDERS = ("claude", "chatgpt", "pi")
_DEFAULT_COMMANDS = {"claude": "claude", "chatgpt": "codex", "pi": "pi"}
# Pi spells the lowest and highest Harness levels differently and clamps the rest per model.
_PI_THINKING = {"none": "off", "ultra": "max"}
# Providers whose CLI accepts a caller-chosen conversation ID for new sessions and forks.
_ASSIGNED_IDENTITY = frozenset({"claude", "pi"})
_CLAUDE_MODELS = frozenset({"haiku", "sonnet", "opus"})
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
        providers = value.get("providers", {})
        if not isinstance(providers, dict) or any(
            name in providers and not isinstance(providers[name], dict)
            for name in PROVIDERS
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
    command = provider_config.get("command", [_DEFAULT_COMMANDS[provider]])
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
    effort_override: str | None = None,
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
    elif provider == "pi" and task == "explore":
        # Pi has no universal cheap model; keep the user's native model selection.
        model, effort = None, "low"
    else:
        model = effort = None
    model = selected.get("model", model)
    effort = selected.get("effort", effort)
    if difficulty is not None and difficulty not in DIFFICULTIES:
        raise SessionError(f"unsupported difficulty {difficulty!r}")
    if model == "by-difficulty":
        if provider not in _DIFFICULTY_PROFILES:
            raise SessionError(f"providers.{provider}.delegations.{task}.model by-difficulty is not supported")
        model, routed_effort = _DIFFICULTY_PROFILES[provider][DIFFICULTIES.index(difficulty or "expert")]
        if "effort" not in selected:
            effort = routed_effort
    if model_override is not None:
        model = model_override
    if effort_override is not None:
        effort = effort_override
    model = None if model == "inherit" else model
    effort = None if effort == "inherit" else effort
    if provider == "pi" and effort == "off":
        effort = "none"
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
        not in EFFORT_LEVELS
    )
    if effort_invalid:
        raise SessionError(
            f"providers.{provider}.delegations.{task}.effort is not valid for {provider}"
        )
    effort = resolve_effort(provider, model, effort)
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
        if provider == "claude":
            arguments.extend(["--effort", effort])
        elif provider == "pi":
            arguments.extend(["--thinking", _PI_THINKING.get(effort, effort)])
        else:
            arguments.extend(["-c", f"model_reasoning_effort={json.dumps(effort)}"])
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
                session_id if provider in _ASSIGNED_IDENTITY else None,
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
    if provider not in PROVIDERS:
        raise SessionError(f"unsupported provider {provider!r}")
    if not isinstance(execution_mode, str) or not execution_mode.strip():
        raise SessionError("observed execution mode must be a nonempty host-defined identity")
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
    if prompt and provider != "claude":
        from subagents_runtime.prompt_paths import normalize_file_references

        prompt = normalize_file_references(prompt, selected_cwd)
    command = [
        *_provider_command(launch_configuration(selected_cwd), provider),
        *provider_arguments(
            provider,
            "interactive",
            session_id if provider in _ASSIGNED_IDENTITY else None,
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
    elif provider == "pi":
        if mode not in {"interactive", "loop"}:
            arguments.extend(["--mode", "json"])
        # --session-id opens the exact session or creates it, so launch and resume share it.
        if fork:
            arguments.extend(["--fork", conversation])
            if fork_id:
                arguments.extend(["--session-id", fork_id])
        elif conversation:
            arguments.extend(["--session-id", conversation])
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


def _pi_alias(model_id: str) -> bool:
    return model_id.endswith("-latest") or re.search(r"-\d{8}$", model_id) is None


def resolve_pi_model(command: list[str], pattern: str, cwd: Path) -> str:
    """Qualify a model pattern against Pi's authenticated models, as Pi's /model picker does.

    Pi's --model flag searches its whole catalogue, including unauthenticated providers, so a
    bare name such as "haiku" can select a provider the user never configured. The matching rules
    mirror Pi's own: an exact provider/id or id first, then a substring preferring aliases.
    """
    from subagents_runtime.processes import native_command

    try:
        listed = subprocess.run(
            native_command([*command, "--offline", "--list-models"]), cwd=cwd,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            stdin=subprocess.DEVNULL,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SessionError(f"could not list Pi models: {exc}") from exc
    rows = [line.split() for line in listed.stdout.splitlines()[1:] if line.strip()]
    models = [(row[0], row[1]) for row in rows if len(row) >= 2]
    if listed.returncode != 0 or not listed.stdout.startswith("provider"):
        raise SessionError("Pi has no authenticated models; configure one before delegating")
    reference = pattern.strip().lower()
    exact = [model for model in models if f"{model[0]}/{model[1]}".lower() == reference]
    candidates = models
    if not exact and "/" in reference:
        provider, _, rest = reference.partition("/")
        if any(model[0].lower() == provider for model in models):
            candidates = [model for model in models if model[0].lower() == provider]
            reference = rest
    exact = exact or [model for model in candidates if model[1].lower() == reference]
    if len(exact) > 1:
        choices = ", ".join(sorted(f"{provider}/{model}" for provider, model in exact))
        raise SessionError(f"Pi model {pattern!r} is ambiguous: {choices}; request provider/model")
    if not exact:
        partial = [model for model in candidates if reference in model[1].lower()]
        aliases = [model for model in partial if _pi_alias(model[1])]
        exact = sorted(aliases or partial, key=lambda model: model[1], reverse=True)[:1]
    if not exact:
        raise SessionError(f"no authenticated Pi model matches {pattern!r}; run `pi --list-models` to see the configured models")
    return f"{exact[0][0]}/{exact[0][1]}"


def _launch_options(launch_config: dict[str, Any], request, cwd: Path) -> list[str]:
    options = delegation_profile_arguments(
        launch_config, request.provider, "loop" if request.mode == "loop" else "general", difficulty=getattr(request, "difficulty", None),
        model_override=getattr(request, "model", None),
        effort_override=getattr(request, "effort", None),
    )
    if request.provider == "pi" and "--model" in options:
        index = options.index("--model") + 1
        options[index] = resolve_pi_model(_provider_command(launch_config, "pi"), options[index], cwd)
    return options


def launch_delegated(request, request_id: str, agent_number: int, cwd: Path) -> str:
    from subagents_runtime.backends import select_backend
    from subagents_runtime.roles import find_skill

    skill = getattr(request, "child_skill", None)
    if not request.resume and skill and find_skill(cwd, request.provider, skill) is None:
        raise SessionError(f"Child skill {skill!r} is unavailable for {request.provider} in {cwd}; install it before launching")
    if request.mode == "loop" and request.provider == "chatgpt":
        from subagents_runtime.codex_trust import trust_worktree
        trust_worktree(cwd)
    if request.mode == "interactive":
        from subagents_runtime.reply_support import prepare

        prepare(cwd, request.provider)
    child_id = select_backend(request, cwd).launch(request, request_id, agent_number, cwd)
    if request.mode == "interactive":
        from subagents_runtime.reply_support import wait_ready
        from subagents_runtime.execution_host import reservation

        wait_ready(reservation(request_id).execution_id, request.provider)
    return child_id


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
        from subagents_runtime.delegation import ensure_inbox, process_inbox

        inbox = ensure_inbox(row[4]).inbox
        path = inbox / (uuid.uuid4().hex + ".md")
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
    if message and row[2] != "claude":
        from subagents_runtime.prompt_paths import normalize_file_references

        message = normalize_file_references(message, Path(row[1]))
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
