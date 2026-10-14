from __future__ import annotations

import json
import math
import os
import re
import tempfile
from abc import ABC, abstractmethod
from contextlib import ExitStack, contextmanager
from dataclasses import fields
from datetime import date, time
from pathlib import Path
from typing import Iterator, Mapping, Sequence

from agent_launcher import LaunchOptions
from agent_launcher.errors import ConfigurationError
from agent_launcher.prompt_paths import normalize_file_references


BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")


def _is_meaningful(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Mapping):
        return bool(value)
    return True


def _toml_key(key: str) -> str:
    return key if BARE_KEY.fullmatch(key) else json.dumps(key, ensure_ascii=False)


def _toml_value(value: object, path: Path | None, label: str) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        return ("inf" if value > 0 else "-inf") if math.isinf(value) else repr(value)
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, Mapping):
        items = ", ".join(
            f"{_toml_key(key)} = {_toml_value(item, path, label)}" for key, item in value.items()
        )
        return "{" + items + "}" if items else "{}"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml_value(item, path, label) for item in value) + "]"
    raise ConfigurationError(
        f"{path}: {label} cannot express {type(value).__name__} values as TOML"
    )


def _flatten(
    settings: Mapping[str, object], prefix: tuple[str, ...], path: Path | None, label: str
) -> list[str]:
    overrides: list[str] = []
    for key, value in settings.items():
        keys = (*prefix, _toml_key(key))
        if isinstance(value, Mapping) and value:
            overrides += _flatten(value, keys, path, label)
        else:
            overrides.append(f"{'.'.join(keys)}={_toml_value(value, path, label)}")
    return overrides


def _is_flag(argument: str, flag: str) -> bool:
    if argument == flag or argument.startswith(flag + "="):
        return True
    attached = len(flag) == 2 and flag.startswith("-") and not flag.startswith("--")
    return attached and argument.startswith(flag) and len(argument) > len(flag)


@contextmanager
def _temporary_file(prefix: str, suffix: str, content: str) -> Iterator[Path]:
    handle, temporary = tempfile.mkstemp(prefix=prefix, suffix=suffix, text=False)
    path = Path(temporary)
    try:
        try:
            os.chmod(path, 0o600)
        except Exception:
            os.close(handle)
            raise
        with os.fdopen(handle, "wb") as stream:
            stream.write(content.encode("utf-8"))
        yield path
    finally:
        path.unlink(missing_ok=True)


class ProviderAdapter(ABC):
    provider: str
    launcher_name: str
    default_command: tuple[str, ...]
    supported_options: frozenset[str] = frozenset()

    def select_command(
        self, commands: Mapping[str, object], path: Path
    ) -> tuple[str, ...]:
        command = commands.get(self.provider)
        if not isinstance(command, tuple) or not command or any(
            not isinstance(item, str) or not item for item in command
        ):
            raise ConfigurationError(
                f"{path}: COMMANDS[{self.provider!r}] must be a non-empty tuple "
                "of non-empty strings"
            )
        if any(Path(item).stem.lower() in {"cch", "cxh"} for item in command):
            raise ConfigurationError(
                f"{path}: COMMANDS[{self.provider!r}] contains a Harness launcher "
                "and would be recursive"
            )
        return command

    def validate_options(self, options: LaunchOptions, path: Path) -> None:
        for field in fields(options):
            value = getattr(options, field.name)
            if field.name not in self.supported_options and _is_meaningful(value):
                raise ConfigurationError(
                    f"{path}: {self.provider}.{field.name} is not supported"
                )
        self.render_settings(options, path)

    def reject_conflicts(
        self,
        arguments: Sequence[str],
        flags: frozenset[str],
        path: Path | None,
        option: str,
    ) -> None:
        conflict = next(
            (flag for argument in arguments for flag in flags if _is_flag(argument, flag)),
            None,
        )
        if conflict is not None:
            raise ConfigurationError(
                f"{path}: {conflict} cannot be used when "
                f"configure() generates {self.provider}.{option}"
            )

    @abstractmethod
    @contextmanager
    def native_arguments(
        self,
        command: tuple[str, ...],
        options: LaunchOptions,
        arguments: Sequence[str],
        path: Path | None,
    ) -> Iterator[list[str]]:
        yield []

    def render(self, options: LaunchOptions) -> str:
        return ""

    def render_settings(self, options: LaunchOptions, path: Path | None = None) -> str:
        return ""


class ClaudeAdapter(ProviderAdapter):
    provider = "claude"
    launcher_name = "cch"
    default_command = ("claude",)
    supported_options = frozenset({"system_prompt", "settings"})
    prompt_flags = frozenset(
        {
            "--system-prompt",
            "--system-prompt-file",
            "--append-system-prompt",
            "--append-system-prompt-file",
        }
    )
    settings_flags = frozenset({"--settings"})

    @contextmanager
    def native_arguments(
        self,
        command: tuple[str, ...],
        options: LaunchOptions,
        arguments: Sequence[str],
        path: Path | None,
    ) -> Iterator[list[str]]:
        with ExitStack() as stack:
            generated: list[str] = []
            if _is_meaningful(options.system_prompt):
                self.reject_conflicts(arguments, self.prompt_flags, path, "system_prompt")
                prompt = stack.enter_context(
                    _temporary_file(
                        "agent-launcher-claude-", ".md", options.system_prompt or ""
                    )
                )
                generated += ["--system-prompt-file", str(prompt)]
            if _is_meaningful(options.settings):
                self.reject_conflicts(arguments, self.settings_flags, path, "settings")
                settings = stack.enter_context(
                    _temporary_file(
                        "agent-launcher-claude-",
                        ".json",
                        self.render_settings(options, path),
                    )
                )
                generated += ["--settings", str(settings)]
            yield [*command, *generated, *arguments]

    def render(self, options: LaunchOptions) -> str:
        return options.system_prompt or ""

    def render_settings(self, options: LaunchOptions, path: Path | None = None) -> str:
        if not _is_meaningful(options.settings):
            return ""
        try:
            return json.dumps(options.settings, ensure_ascii=False, indent=2) + "\n"
        except (TypeError, ValueError) as exc:
            raise ConfigurationError(
                f"{path}: claude.settings is not valid JSON settings: {exc}"
            ) from exc


class ChatGPTAdapter(ProviderAdapter):
    provider = "chatgpt"
    launcher_name = "cxh"
    default_command = ("codex",)
    supported_options = frozenset({"settings"})
    settings_flags = frozenset({"-c", "--config"})
    # Unknown options conservatively consume their next argument. Only these
    # options can precede a positional prompt without an intervening value.
    boolean_flags = frozenset({
        "--search", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust", "--yolo", "--oss", "--no-alt-screen",
        "--json", "--last", "--all", "--skip-git-repo-check", "--ephemeral",
        "--uncommitted", "--help", "-h", "--version", "-V", "--strict-config",
        "--approve-for-me", "--worktree", "--no-daemon", "--ignore-user-config",
        "--ignore-rules", "--include-non-interactive",
    })

    def _prompt_arguments(self, arguments: Sequence[str]) -> list[str]:
        """Adapt prompt operands without rewriting provider options or IDs."""
        normalized = list(arguments)
        operands = []
        after_separator = False
        skip_value = False
        for index, argument in enumerate(arguments):
            if skip_value:
                skip_value = False
            elif after_separator:
                operands.append(index)
            elif argument == "--":
                after_separator = True
            elif argument.startswith("-"):
                attached = len(argument) > 2 and argument[:2] in {"-c", "-i", "-m", "-p", "-s", "-C", "-a", "-o"}
                skip_value = not attached and "=" not in argument and argument not in self.boolean_flags
            else:
                operands.append(index)
        # These are the provider commands that accept a user prompt.
        if operands and arguments[operands[0]] in {"exec", "e", "resume", "fork", "review"}:
            command = arguments[operands.pop(0)]
            if operands and command in {"exec", "e"} and arguments[operands[0]] in {"resume", "fork", "review"}:
                command = arguments[operands.pop(0)]
            if command in {"resume", "fork"} and "--last" not in arguments and operands:
                operands.pop(0)  # The conversation ID is a separate operand.
        elif operands and arguments[operands[0]] in {
            "app-server", "remote-control", "app", "debug", "apply", "a", "archive",
            "unarchive", "delete", "cloud", "completion", "doctor", "features",
            "execpolicy", "login", "logout", "mcp", "plugin", "mcp-server",
            "sandbox", "update", "help", "agents", "queue", "migrate-rollouts", "exec-server",
        }:
            return normalized
        cwd = Path.cwd()
        for index in operands:
            normalized[index] = normalize_file_references(arguments[index], cwd)
        return normalized

    @contextmanager
    def native_arguments(
        self,
        command: tuple[str, ...],
        options: LaunchOptions,
        arguments: Sequence[str],
        path: Path | None,
    ) -> Iterator[list[str]]:
        overrides = self._overrides(options, path)
        if overrides:
            self.reject_conflicts(arguments, self.settings_flags, path, "settings")
        generated = [item for override in overrides for item in ("-c", override)]
        yield [*command, *generated, *self._prompt_arguments(arguments)]

    def _overrides(self, options: LaunchOptions, path: Path | None) -> list[str]:
        if not _is_meaningful(options.settings):
            return []
        return _flatten(options.settings or {}, (), path, "chatgpt.settings")

    def render_settings(self, options: LaunchOptions, path: Path | None = None) -> str:
        return "".join(f"-c {override}\n" for override in self._overrides(options, path))


ADAPTERS: dict[str, ProviderAdapter] = {
    "claude": ClaudeAdapter(),
    "chatgpt": ChatGPTAdapter(),
}
