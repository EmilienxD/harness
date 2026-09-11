from __future__ import annotations

import os
import tempfile
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import fields
from pathlib import Path
from typing import Iterator, Mapping, Sequence

from agent_launcher import LaunchOptions
from agent_launcher.errors import ConfigurationError


def _is_meaningful(value: object) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


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


class ClaudeAdapter(ProviderAdapter):
    provider = "claude"
    launcher_name = "cch"
    default_command = ("claude",)
    supported_options = frozenset({"system_prompt"})
    prompt_flags = frozenset(
        {
            "--system-prompt",
            "--system-prompt-file",
            "--append-system-prompt",
            "--append-system-prompt-file",
        }
    )

    @contextmanager
    def native_arguments(
        self,
        command: tuple[str, ...],
        options: LaunchOptions,
        arguments: Sequence[str],
        path: Path | None,
    ) -> Iterator[list[str]]:
        prompt = options.system_prompt
        if prompt is None or not prompt.strip():
            yield [*command, *arguments]
            return
        for argument in arguments:
            conflict = next(
                (
                    flag
                    for flag in self.prompt_flags
                    if argument == flag or argument.startswith(flag + "=")
                ),
                None,
            )
            if conflict is not None:
                raise ConfigurationError(
                    f"{path}: {conflict} cannot be used when "
                    "configure() generates claude.system_prompt"
                )
        handle, temporary = tempfile.mkstemp(
            prefix="agent-launcher-claude-", suffix=".md", text=False
        )
        prompt_path = Path(temporary)
        try:
            try:
                os.chmod(prompt_path, 0o600)
            except Exception:
                os.close(handle)
                raise
            with os.fdopen(handle, "wb") as stream:
                stream.write(prompt.encode("utf-8"))
            yield [*command, "--system-prompt-file", str(prompt_path), *arguments]
        finally:
            prompt_path.unlink(missing_ok=True)

    def render(self, options: LaunchOptions) -> str:
        return options.system_prompt or ""


class ChatGPTAdapter(ProviderAdapter):
    provider = "chatgpt"
    launcher_name = "cxh"
    default_command = ("codex",)

    @contextmanager
    def native_arguments(
        self,
        command: tuple[str, ...],
        options: LaunchOptions,
        arguments: Sequence[str],
        path: Path | None,
    ) -> Iterator[list[str]]:
        yield [*command, *arguments]


ADAPTERS: dict[str, ProviderAdapter] = {
    "claude": ClaudeAdapter(),
    "chatgpt": ChatGPTAdapter(),
}
