from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from agent_launcher import LaunchConfiguration, LaunchOptions
from agent_launcher.cli import (
    ConfigurationError,
    chatgpt_entrypoint,
    claude_entrypoint,
    initialize,
    main,
    render,
)


PROVIDERS = (("claude", "cch", "claude"), ("chatgpt", "cxh", "codex"))
RUNTIME_SRC = Path(__file__).parents[2] / "harness/productivity/agent-launcher/runtime/src"


def write_config(project: Path, body: str) -> Path:
    root = project / ".harness" / "agent-launcher"
    root.mkdir(parents=True)
    path = root / "config.py"
    path.write_text(body, encoding="utf-8")
    return path


def config(
    claude_prompt: str | None = None,
    chatgpt_prompt: str | None = None,
    commands: dict[str, tuple[str, ...]] | None = None,
) -> str:
    selected = commands or {"claude": ("claude",), "chatgpt": ("codex",)}
    return (
        "from agent_launcher import LaunchConfiguration, LaunchOptions\n"
        "CONFIG_VERSION = 1\n"
        f"COMMANDS = {selected!r}\n"
        "def configure():\n"
        "    return LaunchConfiguration(\n"
        f"        claude=LaunchOptions(system_prompt={claude_prompt!r}),\n"
        f"        chatgpt=LaunchOptions(system_prompt={chatgpt_prompt!r}),\n"
        "    )\n"
    )


@pytest.mark.parametrize(("provider", "_entrypoint", "executable"), PROVIDERS)
def test_absent_configuration_launches_provider_unchanged(
    tmp_path, monkeypatch, provider, _entrypoint, executable
):
    monkeypatch.chdir(tmp_path)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 17)
    arguments = ["--hns-init-later", "value with spaces", "--flag=unchanged"]

    assert main(arguments, provider=provider) == 17
    assert seen == [executable, *arguments]
    assert render(provider=provider) == ""


@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_nearest_config_preserves_cwd_and_forwards_custom_command(
    tmp_path, monkeypatch, provider, _entrypoint, _executable
):
    outer, inner = tmp_path / "outer", tmp_path / "outer" / "inner"
    nested = inner / "src"
    nested.mkdir(parents=True)
    write_config(outer, config(commands={"claude": ("outer-c",), "chatgpt": ("outer-x",)}))
    body = config(commands={"claude": ("inner-c", "fixed"), "chatgpt": ("inner-x", "fixed")})
    body = body.replace(
        "def configure():",
        "def configure():\n    import os\n    assert os.getcwd().endswith('src')",
    )
    write_config(inner, body)
    monkeypatch.chdir(nested)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 0)

    assert main(["--resume", "thread", "--", "prompt"], provider=provider) == 0
    assert seen == ["inner-c" if provider == "claude" else "inner-x", "fixed", "--resume", "thread", "--", "prompt"]


@pytest.mark.parametrize(("provider", "entrypoint", "_executable"), PROVIDERS)
def test_init_is_shared_idempotent_and_does_not_import_config(
    tmp_path, provider, entrypoint, _executable
):
    project = tmp_path / provider
    path = write_config(project, "raise RuntimeError('must not run')\n")

    assert main(["--hns-init", str(project)], provider=provider) == 0
    assert initialize(project) == 0
    assert path.read_text(encoding="utf-8") == "raise RuntimeError('must not run')\n"
    root = project / ".harness" / "agent-launcher"
    assert (root / "system-prompt.md").is_file()
    assert (root / "extensions" / "__init__.py").is_file()
    assert entrypoint in {"cch", "cxh"}


def test_init_preserves_existing_starter(tmp_path):
    existing = tmp_path / ".harness" / "agent-launcher" / "system-prompt.md"
    existing.parent.mkdir(parents=True)
    existing.write_text("mine", encoding="utf-8")
    assert initialize(tmp_path) == 2
    assert existing.read_text(encoding="utf-8") == "mine"


def test_render_is_provider_specific(tmp_path, monkeypatch, capsys):
    write_config(tmp_path, config(claude_prompt="héllo\n"))
    monkeypatch.chdir(tmp_path)
    assert render(provider="claude") == "héllo\n"
    assert render(provider="chatgpt") == ""
    assert main(["--hns-render"], provider="chatgpt") == 0
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("prompt", [None, "", " \n\t"])
@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_blank_options_do_not_change_native_arguments(
    tmp_path, monkeypatch, prompt, provider, _entrypoint, _executable
):
    prompts = {"claude": None, "chatgpt": None}
    prompts[provider] = prompt
    commands = {"claude": ("custom-c",), "chatgpt": ("custom-x",)}
    write_config(tmp_path, config(prompts["claude"], prompts["chatgpt"], commands))
    monkeypatch.chdir(tmp_path)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 0)
    arguments = ["--resume", "a b", "--system-prompt", "native"]

    assert main(arguments, provider=provider) == 0
    assert seen == ["custom-c" if provider == "claude" else "custom-x", *arguments]


def test_chatgpt_is_strict_pass_through_without_prompt_resources(tmp_path, monkeypatch):
    write_config(tmp_path, config(claude_prompt="Claude only"))
    monkeypatch.chdir(tmp_path)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 0)
    monkeypatch.setattr(
        "agent_launcher.adapters.tempfile.mkstemp",
        lambda **_kwargs: pytest.fail("Codex adapter created a prompt file"),
    )
    arguments = ["exec", "--json", "--", "say hello", "--system-prompt-file"]
    assert main(arguments, provider="chatgpt") == 0
    assert seen == ["codex", *arguments]


@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_chatgpt_rejects_nonblank_system_prompt(
    tmp_path, monkeypatch, provider, _entrypoint, _executable
):
    path = write_config(tmp_path, config(chatgpt_prompt="do not approximate this"))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match=r"chatgpt\.system_prompt.*not supported") as error:
        main([], provider=provider)
    assert str(path) in str(error.value)


@pytest.mark.parametrize(
    "argument",
    ["--system-prompt=native", "--system-prompt-file", "--append-system-prompt=also", "--append-system-prompt-file"],
)
def test_claude_generated_prompt_rejects_native_conflicts(tmp_path, monkeypatch, argument):
    path = write_config(tmp_path, config(claude_prompt="generated"))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match=argument.split("=")[0]) as error:
        main([argument], provider="claude")
    assert str(path) in str(error.value)


def test_claude_prompt_file_exact_content_lifetime_and_exit_code(tmp_path, monkeypatch):
    prompt = "  héllo 世界\n\t"
    write_config(tmp_path, config(claude_prompt=prompt))
    monkeypatch.chdir(tmp_path)
    observed = {}

    def run_child(argv):
        prompt_path = Path(argv[argv.index("--system-prompt-file") + 1])
        observed.update(argv=argv, path=prompt_path, content=prompt_path.read_text(encoding="utf-8"))
        assert prompt_path.is_file()
        return 23

    monkeypatch.setattr("agent_launcher.cli._run_child", run_child)
    assert main(["--model", "opus"], provider="claude") == 23
    assert observed["argv"][0] == "claude"
    assert observed["argv"][-2:] == ["--model", "opus"]
    assert observed["content"] == prompt
    assert not observed["path"].exists()


@pytest.mark.parametrize(("provider", "entrypoint", "_executable"), PROVIDERS)
def test_recursive_provider_command_is_rejected(tmp_path, monkeypatch, provider, entrypoint, _executable):
    commands = {"claude": ("claude",), "chatgpt": ("codex",)}
    commands[provider] = (entrypoint,)
    write_config(tmp_path, config(commands=commands))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match="recursive"):
        main([], provider=provider)


@pytest.mark.parametrize(
    ("before", "after", "message"),
    [
        ("CONFIG_VERSION = 1", "CONFIG_VERSION = 2", "CONFIG_VERSION"),
        ("COMMANDS = {'claude': ('claude',), 'chatgpt': ('codex',)}", "COMMANDS = []", "COMMANDS"),
        ("def configure():", "def configure(required):", "no arguments"),
        (
            "    return LaunchConfiguration(\n"
            "        claude=LaunchOptions(system_prompt='x'),\n"
            "        chatgpt=LaunchOptions(system_prompt=None),\n"
            "    )",
            "    return object()",
            "return LaunchConfiguration",
        ),
        ("claude=LaunchOptions(system_prompt='x')", "claude=LaunchOptions(system_prompt=3)", "claude.system_prompt"),
    ],
)
@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_configuration_failures_name_config(
    tmp_path, monkeypatch, before, after, message, provider, _entrypoint, _executable
):
    path = write_config(tmp_path, config(claude_prompt="x").replace(before, after))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match=message) as error:
        main([], provider=provider)
    assert str(path) in str(error.value)


@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_process_inherits_streams_and_propagates_exit_code(tmp_path, provider, _entrypoint, _executable):
    project = tmp_path / provider
    project.mkdir()
    fake = tmp_path / f"fake_{provider}.py"
    fake.write_text(
        "import sys\nvalue = sys.stdin.read()\nsys.stdout.write('out:' + value + ':' + repr(sys.argv[1:]))\n"
        "sys.stderr.write('err:' + value)\nraise SystemExit(29)\n",
        encoding="utf-8",
    )
    commands = {"claude": (sys.executable, str(fake)), "chatgpt": (sys.executable, str(fake))}
    write_config(project, config(commands=commands))
    env = {**os.environ, "PYTHONPATH": str(RUNTIME_SRC)}
    function = "claude_entrypoint" if provider == "claude" else "chatgpt_entrypoint"
    result = subprocess.run(
        [sys.executable, "-c", f"from agent_launcher.cli import {function}; {function}()", "--alpha", "two words"],
        cwd=project,
        env=env,
        input="hello",
        text=True,
        capture_output=True,
    )
    assert result.returncode == 29
    assert result.stdout == "out:hello:['--alpha', 'two words']"
    assert result.stderr == "err:hello"


@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_signals_are_forwarded_for_each_provider(tmp_path, monkeypatch, provider, _entrypoint, _executable):
    monkeypatch.chdir(tmp_path)
    installed, sent = {}, []

    def install_handler(sig, handler):
        previous = installed.get(sig, signal.SIG_DFL)
        installed[sig] = handler
        return previous

    class Child:
        def send_signal(self, sig):
            sent.append(sig)

        def wait(self):
            installed[signal.SIGTERM](signal.SIGTERM, None)
            return 0

    monkeypatch.setattr("agent_launcher.cli.signal.signal", install_handler)
    monkeypatch.setattr("agent_launcher.cli.subprocess.Popen", lambda _argv: Child())
    assert main([], provider=provider) == 0
    assert sent == [signal.SIGTERM]


@pytest.mark.parametrize(("function", "label"), [(claude_entrypoint, "cch"), (chatgpt_entrypoint, "cxh")])
def test_entrypoints_label_configuration_failures(tmp_path, monkeypatch, capsys, function, label):
    write_config(tmp_path, config().replace("CONFIG_VERSION = 1", "CONFIG_VERSION = 2"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", [label])
    with pytest.raises(SystemExit, match="2"):
        function()
    assert capsys.readouterr().err.startswith(f"{label}: ")


def test_configuration_dataclasses_are_provider_specific():
    configuration = LaunchConfiguration(
        claude=LaunchOptions(system_prompt="claude context"), chatgpt=LaunchOptions()
    )
    assert configuration.claude.system_prompt == "claude context"
    assert configuration.chatgpt.system_prompt is None
