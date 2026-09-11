from pathlib import Path

from agent_launcher import LaunchConfiguration, LaunchOptions


CONFIG_VERSION = 1
COMMANDS = {
    "claude": ("claude",),
    "chatgpt": ("codex",),
}


def configure() -> LaunchConfiguration:
    prompt = Path(__file__).with_name("system-prompt.md").read_text(encoding="utf-8")
    return LaunchConfiguration(
        claude=LaunchOptions(system_prompt=prompt),
        chatgpt=LaunchOptions(),
    )
