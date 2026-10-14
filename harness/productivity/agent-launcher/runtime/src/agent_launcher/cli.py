from __future__ import annotations

import importlib.util
import inspect
import shutil
import signal
import subprocess
import sys
from contextlib import contextmanager
from importlib.resources import files
from pathlib import Path
from types import ModuleType
from typing import Iterator, Mapping, Sequence

from agent_launcher import LaunchConfiguration, LaunchOptions
from agent_launcher.adapters import ADAPTERS, ProviderAdapter
from agent_launcher.errors import ConfigurationError


CONFIG_VERSION = 1
COMMANDS = {provider: adapter.default_command for provider, adapter in ADAPTERS.items()}
CONFIG_RELATIVE_PATH = Path(".harness/agent-launcher/config.py")


def _adapter(provider: str) -> ProviderAdapter:
    try:
        return ADAPTERS[provider]
    except KeyError as exc:
        raise ValueError(f"unknown provider {provider!r}") from exc


def _find_config(start: Path | None = None) -> Path | None:
    current = (start or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        candidate = directory / CONFIG_RELATIVE_PATH
        if candidate.is_file():
            return candidate
        if (directory / ".git").exists():
            break
    return None


@contextmanager
def _config_import_path(directory: Path) -> Iterator[None]:
    value = str(directory)
    sys.path.insert(0, value)
    try:
        yield
    finally:
        try:
            sys.path.remove(value)
        except ValueError:
            pass


def _load_module(path: Path) -> ModuleType:
    name = f"_harness_agent_launcher_config_{abs(hash(path))}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ConfigurationError(f"{path}: could not load configuration")
    module = importlib.util.module_from_spec(spec)
    try:
        with _config_import_path(path.parent):
            spec.loader.exec_module(module)
    except Exception as exc:
        raise ConfigurationError(f"{path}: configuration import failed: {exc}") from exc
    return module


def _validate_settings(provider: str, settings: object, path: Path) -> None:
    if not isinstance(settings, Mapping):
        raise ConfigurationError(
            f"{path}: {provider}.settings must be a mapping or None"
        )
    for key, value in settings.items():
        if not isinstance(key, str) or not key:
            raise ConfigurationError(
                f"{path}: {provider}.settings keys must be non-empty strings"
            )
        if isinstance(value, Mapping):
            _validate_settings(provider, value, path)


def _validate_options(provider: str, options: object, path: Path) -> LaunchOptions:
    if not isinstance(options, LaunchOptions):
        raise ConfigurationError(f"{path}: configure().{provider} must be LaunchOptions")
    if options.system_prompt is not None and not isinstance(options.system_prompt, str):
        raise ConfigurationError(
            f"{path}: {provider}.system_prompt must be a string or None"
        )
    if options.settings is not None:
        _validate_settings(provider, options.settings, path)
    _adapter(provider).validate_options(options, path)
    return options


def _load_configuration(
    path: Path,
) -> tuple[dict[str, tuple[str, ...]], LaunchConfiguration]:
    module = _load_module(path)
    version = getattr(module, "CONFIG_VERSION", None)
    if type(version) is not int or version != CONFIG_VERSION:
        raise ConfigurationError(f"{path}: CONFIG_VERSION must be {CONFIG_VERSION}")
    raw_commands = getattr(module, "COMMANDS", None)
    if not isinstance(raw_commands, dict) or set(raw_commands) != set(ADAPTERS):
        raise ConfigurationError(
            f"{path}: COMMANDS must be a mapping with exactly claude and chatgpt"
        )
    commands = {
        provider: adapter.select_command(raw_commands, path)
        for provider, adapter in ADAPTERS.items()
    }
    configure = getattr(module, "configure", None)
    if not callable(configure):
        raise ConfigurationError(f"{path}: configure must be callable")
    try:
        inspect.signature(configure).bind()
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{path}: configure() must accept no arguments") from exc
    try:
        configuration = configure()
    except Exception as exc:
        raise ConfigurationError(f"{path}: configure() failed: {exc}") from exc
    if not isinstance(configuration, LaunchConfiguration):
        raise ConfigurationError(f"{path}: configure() must return LaunchConfiguration")
    claude = _validate_options("claude", configuration.claude, path)
    chatgpt = _validate_options("chatgpt", configuration.chatgpt, path)
    return commands, LaunchConfiguration(claude=claude, chatgpt=chatgpt)


def _configured(
    start: Path | None = None,
) -> tuple[Path, Mapping[str, tuple[str, ...]], LaunchConfiguration]:
    path = _find_config(start)
    if path is None:
        raise ConfigurationError(
            f"agent-launcher is not enabled for {start or Path.cwd()}: "
            f"no {CONFIG_RELATIVE_PATH.as_posix()} found in this project. "
            "Install agent-launcher with project scope or run "
            "cch --hns-init / cxh --hns-init at the project root."
        )
    commands, configuration = _load_configuration(path)
    return path, commands, configuration


def render(start: Path | None = None, *, provider: str = "claude") -> str:
    _path, _commands, configuration = _configured(start)
    return _adapter(provider).render(getattr(configuration, provider))


def render_settings(start: Path | None = None, *, provider: str = "claude") -> str:
    path, _commands, configuration = _configured(start)
    return _adapter(provider).render_settings(getattr(configuration, provider), path)


def initialize(project: Path) -> int:
    destination = project / CONFIG_RELATIVE_PATH.parent
    templates = files("agent_launcher").joinpath("templates")
    created = 0
    for relative in (
        Path("config.py"),
        Path("system-prompt.md"),
        Path("claude/settings.json"),
        Path("chatgpt/config.toml"),
        Path("extensions/__init__.py"),
    ):
        target = destination / relative
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(templates.joinpath(relative.as_posix()).read_bytes())
        created += 1
    return created


def _run_child(argv: list[str]) -> int:
    executable = shutil.which(argv[0]) or argv[0]
    child = subprocess.Popen([executable, *argv[1:]])
    previous: dict[signal.Signals, object] = {}

    def forward(signum, _frame):
        try:
            child.send_signal(signum)
        except (OSError, ValueError):
            pass

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                previous[sig] = signal.signal(sig, forward)
            except (OSError, ValueError):
                pass
    try:
        returncode = child.wait()
        return 128 - returncode if returncode < 0 else returncode
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _launch(arguments: list[str], provider: str) -> int:
    adapter = _adapter(provider)
    path, commands, configuration = _configured()
    options = getattr(configuration, provider)
    with adapter.native_arguments(commands[provider], options, arguments, path) as argv:
        return _run_child(argv)


def main(argv: Sequence[str] | None = None, *, provider: str = "claude") -> int:
    _adapter(provider)
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "--hns-init":
        if len(arguments) > 2:
            raise ConfigurationError("--hns-init accepts at most one PATH")
        project = Path(arguments[1]) if len(arguments) == 2 else Path.cwd()
        initialize(project)
        return 0
    if arguments and arguments[0] == "--hns-render":
        if len(arguments) != 1:
            raise ConfigurationError("--hns-render accepts no arguments")
        sys.stdout.write(render(provider=provider))
        return 0
    if arguments and arguments[0] == "--hns-render-settings":
        if len(arguments) != 1:
            raise ConfigurationError("--hns-render-settings accepts no arguments")
        sys.stdout.write(render_settings(provider=provider))
        return 0
    return _launch(arguments, provider)


def _entrypoint(provider: str, name: str) -> None:
    try:
        raise SystemExit(main(provider=provider))
    except ConfigurationError as exc:
        print(f"{name}: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


def claude_entrypoint() -> None:
    _entrypoint("claude", "cch")


def chatgpt_entrypoint() -> None:
    _entrypoint("chatgpt", "cxh")


if __name__ == "__main__":
    name = Path(sys.argv[0]).stem.lower()
    chatgpt_entrypoint() if name == "cxh" else claude_entrypoint()


__all__ = [
    "ConfigurationError",
    "chatgpt_entrypoint",
    "claude_entrypoint",
    "initialize",
    "main",
    "render",
    "render_settings",
]
