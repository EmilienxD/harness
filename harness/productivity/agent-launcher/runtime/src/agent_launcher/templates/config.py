import json
import tomllib
from pathlib import Path

from agent_launcher import LaunchConfiguration, LaunchOptions


CONFIG_VERSION = 1
COMMANDS = {
    "claude": ("claude",),
    "chatgpt": ("codex",),
}
DIRECTORY = Path(__file__).parent


def read(relative: str, parse) -> dict:
    path = DIRECTORY / relative
    return parse(path.read_text(encoding="utf-8")) if path.is_file() else {}


def configure() -> LaunchConfiguration:
    prompt = DIRECTORY.joinpath("system-prompt.md").read_text(encoding="utf-8")
    return LaunchConfiguration(
        claude=LaunchOptions(
            system_prompt=prompt,
            settings=read("claude/settings.json", json.loads),
        ),
        chatgpt=LaunchOptions(settings=read("chatgpt/config.toml", tomllib.loads)),
    )
