from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tomllib
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
    render_settings,
)


PROVIDERS = (("claude", "cch", "claude"), ("chatgpt", "cxh", "codex"))
RUNTIME_SRC = Path(__file__).parents[2] / "harness/productivity/agent-launcher/runtime/src"


def write_config(project: Path, body: str) -> Path:
    root = project / ".harness" / "agent-launcher"
    root.mkdir(parents=True)
    path = root / "config.py"
    path.write_text(body, encoding="utf-8")
    return path


def options(prompt: str | None, settings: dict | None) -> str:
    arguments = f"system_prompt={prompt!r}"
    if settings is not None:
        arguments += f", settings={settings!r}"
    return f"LaunchOptions({arguments})"


def config(
    claude_prompt: str | None = None,
    chatgpt_prompt: str | None = None,
    commands: dict[str, tuple[str, ...]] | None = None,
    claude_settings: dict | None = None,
    chatgpt_settings: dict | None = None,
) -> str:
    selected = commands or {"claude": ("claude",), "chatgpt": ("codex",)}
    return (
        "from agent_launcher import LaunchConfiguration, LaunchOptions\n"
        "CONFIG_VERSION = 1\n"
        f"COMMANDS = {selected!r}\n"
        "def configure():\n"
        "    return LaunchConfiguration(\n"
        f"        claude={options(claude_prompt, claude_settings)},\n"
        f"        chatgpt={options(chatgpt_prompt, chatgpt_settings)},\n"
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
    assert initialize(tmp_path) == 4
    assert existing.read_text(encoding="utf-8") == "mine"


def test_init_creates_inert_launcher_only_settings_starters(tmp_path):
    assert initialize(tmp_path) == 5
    root = tmp_path / ".harness" / "agent-launcher"
    assert json.loads((root / "claude" / "settings.json").read_text(encoding="utf-8")) == {}
    assert tomllib.loads((root / "chatgpt" / "config.toml").read_text(encoding="utf-8")) == {}
    assert render_settings(root, provider="claude") == ""
    assert render_settings(root, provider="chatgpt") == ""


def test_initialized_project_loads_the_settings_the_user_writes(tmp_path, monkeypatch):
    initialize(tmp_path)
    root = tmp_path / ".harness" / "agent-launcher"
    (root / "claude" / "settings.json").write_text('{"model": "opus"}', encoding="utf-8")
    (root / "chatgpt" / "config.toml").write_text(
        'model = "o3"\n\n[tui]\ntheme = "dark"\n', encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert render_settings(provider="claude") == '{\n  "model": "opus"\n}\n'
    assert render_settings(provider="chatgpt") == '-c model="o3"\n-c tui.theme="dark"\n'


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


def test_claude_prompt_file_lifetime_and_exit_code(tmp_path, monkeypatch):
    prompt = "  héllo 世界\n\t"
    write_config(tmp_path, config(claude_prompt=prompt))
    monkeypatch.chdir(tmp_path)
    observed = {}

    def run_child(argv):
        prompt_path = Path(argv[argv.index("--system-prompt-file") + 1])
        observed.update(argv=argv, path=prompt_path)
        assert prompt_path.is_file()
        return 23

    monkeypatch.setattr("agent_launcher.cli._run_child", run_child)
    assert main(["--model", "opus"], provider="claude") == 23
    assert observed["argv"][0] == "claude"
    assert observed["argv"][-2:] == ["--model", "opus"]
    assert not observed["path"].exists()


def test_claude_settings_file_exact_content_lifetime_and_arguments(tmp_path, monkeypatch):
    settings = {"model": "opus", "env": {"KEY": "vàlue"}, "permissions": {"allow": ["Bash(ls:*)"]}}
    write_config(tmp_path, config(claude_settings=settings))
    monkeypatch.chdir(tmp_path)
    observed = {}

    def run_child(argv):
        settings_path = Path(argv[argv.index("--settings") + 1])
        observed.update(
            argv=argv,
            path=settings_path,
            content=json.loads(settings_path.read_text(encoding="utf-8")),
        )
        return 11

    monkeypatch.setattr("agent_launcher.cli._run_child", run_child)
    assert main(["--model", "opus"], provider="claude") == 11
    assert observed["argv"][0] == "claude"
    assert observed["argv"][-2:] == ["--model", "opus"]
    assert observed["content"] == settings
    assert not observed["path"].exists()


def test_chatgpt_settings_become_flattened_config_overrides(tmp_path, monkeypatch):
    settings = {
        "model": "gpt-5.6-sol",
        "sandbox_permissions": ["disk-full-read-access"],
        "tui": {"theme": "dark", "vim_mode_default": True},
        "history": {"max_bytes": 1024},
        "shell_environment_policy": {"inherit": "all"},
    }
    write_config(tmp_path, config(chatgpt_settings=settings))
    monkeypatch.chdir(tmp_path)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 0)

    assert main(["exec", "say hello"], provider="chatgpt") == 0
    assert seen == [
        "codex",
        "-c",
        'model="gpt-5.6-sol"',
        "-c",
        'sandbox_permissions=["disk-full-read-access"]',
        "-c",
        'tui.theme="dark"',
        "-c",
        "tui.vim_mode_default=true",
        "-c",
        "history.max_bytes=1024",
        "-c",
        'shell_environment_policy.inherit="all"',
        "exec",
        "say hello",
    ]


@pytest.mark.parametrize(
    ("provider", "argument", "flag"),
    [
        ("claude", "--settings", "--settings"),
        ("claude", "--settings=/elsewhere.json", "--settings"),
        ("chatgpt", "-c", "-c"),
        ("chatgpt", '-cmodel="o3"', "-c"),
        ("chatgpt", "--config", "--config"),
        ("chatgpt", '--config=model="o3"', "--config"),
    ],
)
def test_generated_settings_reject_native_settings_arguments(
    tmp_path, monkeypatch, provider, argument, flag
):
    keyword = {f"{provider}_settings": {"model": "generated"}}
    path = write_config(tmp_path, config(**keyword))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match=f"{flag} cannot be used") as error:
        main([argument], provider=provider)
    assert f"{provider}.settings" in str(error.value)
    assert str(path) in str(error.value)


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("claude", '{\n  "model": "opus",\n  "env": {\n    "KEY": "value"\n  }\n}\n'),
        ("chatgpt", '-c model="o3"\n-c tui.theme="dark"\n'),
    ],
)
def test_render_settings_reports_the_resolved_native_settings(
    tmp_path, monkeypatch, capsys, provider, expected
):
    write_config(
        tmp_path,
        config(
            claude_settings={"model": "opus", "env": {"KEY": "value"}},
            chatgpt_settings={"model": "o3", "tui": {"theme": "dark"}},
        ),
    )
    monkeypatch.chdir(tmp_path)
    assert render_settings(provider=provider) == expected
    assert main(["--hns-render-settings"], provider=provider) == 0
    assert capsys.readouterr().out == expected


@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_render_settings_is_empty_without_configured_settings(
    tmp_path, monkeypatch, provider, _entrypoint, _executable
):
    write_config(tmp_path, config(claude_prompt="prompt only", claude_settings={}))
    monkeypatch.chdir(tmp_path)
    seen = []
    monkeypatch.setattr("agent_launcher.cli._run_child", lambda argv: seen.extend(argv) or 0)

    assert render_settings(provider=provider) == ""
    assert main(["--resume"], provider=provider) == 0
    assert "--settings" not in seen and "-c" not in seen


@pytest.mark.parametrize(
    ("keyword", "settings", "message"),
    [
        ("claude_settings", 3, r"claude\.settings must be a mapping"),
        ("claude_settings", {"model": ...}, r"claude\.settings is not valid JSON settings"),
        ("chatgpt_settings", {"": "x"}, r"chatgpt\.settings keys must be non-empty strings"),
        (
            "chatgpt_settings",
            {"history": {"max_bytes": None}},
            r"chatgpt\.settings cannot express NoneType values as TOML",
        ),
    ],
)
@pytest.mark.parametrize(("provider", "_entrypoint", "_executable"), PROVIDERS)
def test_unusable_settings_are_rejected_for_every_entrypoint(
    tmp_path, monkeypatch, keyword, settings, message, provider, _entrypoint, _executable
):
    path = write_config(tmp_path, config(**{keyword: settings}))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match=message) as error:
        main([], provider=provider)
    assert str(path) in str(error.value)


def test_chatgpt_overrides_quote_keys_and_keep_tables_addressable(tmp_path, monkeypatch):
    settings = {
        "mcp_servers": {"my server": {"command": "npx", "args": ["-y", "pkg"]}},
        "projects": {"/home/me/code": {"trust_level": "trusted"}},
        "tui": {},
    }
    write_config(tmp_path, config(chatgpt_settings=settings))
    monkeypatch.chdir(tmp_path)

    assert render_settings(provider="chatgpt") == (
        '-c mcp_servers."my server".command="npx"\n'
        '-c mcp_servers."my server".args=["-y", "pkg"]\n'
        '-c projects."/home/me/code".trust_level="trusted"\n'
        "-c tui={}\n"
    )


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


@pytest.mark.skipif(sys.platform != "win32", reason="Windows command shim behavior")
def test_chatgpt_launch_resolves_cmd_shim_from_path(tmp_path, monkeypatch):
    shim = tmp_path / "codex.cmd"
    shim.write_text("@exit /b 23\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])

    assert main([], provider="chatgpt") == 23


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


def test_unsupported_child_signal_does_not_crash_launcher(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    installed = {}

    def install_handler(sig, handler):
        previous = installed.get(sig, signal.SIG_DFL)
        installed[sig] = handler
        return previous

    class Child:
        def send_signal(self, sig):
            raise ValueError(f"Unsupported signal: {sig}")

        def wait(self):
            installed[signal.SIGINT](signal.SIGINT, None)
            return 0

    monkeypatch.setattr("agent_launcher.cli.signal.signal", install_handler)
    monkeypatch.setattr("agent_launcher.cli.subprocess.Popen", lambda _argv: Child())
    assert main([], provider="claude") == 0


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
