"""Neutralize built-in CLI commands while preserving skill invocations."""

from __future__ import annotations

import json
import re
from pathlib import Path


# Canonical provider lists and token boundaries may also be consumed by execution hosts.
# Lists exclude bundled skills and their aliases. Provider evidence:
# docs/CHATGPT-REFERENCES/developer-commands.md, docs/CLAUDE-REFERENCES/skills.md,
# docs/PI-REFERENCES/docs/slash-commands.md, https://code.claude.com/docs/en/commands
_RULES = json.loads(Path(__file__).with_name("prompt-commands.json").read_text(encoding="utf-8"))
BUILTIN_COMMANDS = {
    provider: frozenset(commands) for provider, commands in _RULES["commands"].items()
}
INVOCATION = re.compile(_RULES["invocationPattern"])


def sanitize_prompt_commands(prompt: str, provider: str) -> str:
    """Delete only the slash prefix of built-in commands for the receiver.

    Work on the launch copy, after resume routing and before the runtime adds
    its intentional task skill. Skills, unknown names, paths and variables survive.
    """
    commands = BUILTIN_COMMANDS[provider]

    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in commands:
            return name
        return match.group()

    return INVOCATION.sub(substitute, prompt)
