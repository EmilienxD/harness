"""Neutralize built-in CLI commands while preserving skill invocations."""

from __future__ import annotations

import re


# Documented built-in command names and aliases, excluding bundled skills and
# their aliases (for example Claude's /code-review and /review). Keep these
# provider-specific; availability varies by CLI version, platform and account.
# https://code.claude.com/docs/en/commands (2026-10-16)
# docs/CHATGPT-REFERENCES/developer-commands.md, "Built-in slash commands"
BUILTIN_COMMANDS = {
    "claude": frozenset("""
        add-dir advisor agents artifacts
        auto-mode-setup autocompact autofix-pr background bg branch btw bug
        cd checkpoint chrome clear
        color compact config context continue copy cost
        design-login desktop app diff effort exit export
        extra-usage fast feedback focus fork goal heapdump
        help hooks ide import init insights install-github-app install-slack-app
        keybindings list-agents peers login logout mcp memory mobile
        ios android model new output-style passes permissions allowed-tools plan
        plugin powerup pr-comments privacy-settings quit radio
        rate-limit-options recap release-notes reload-plugins reload-skills
        remote-control rc remote-env rename reset resume rewind
        sandbox schedule routines scroll-speed security-review
        setup-bedrock setup-vertex settings skill-doctor skills
        stats status statusline stickers stop subtask tasks bashes team-onboarding
        teleport tp terminal-setup theme tui ultraplan undo
        upgrade usage usage-credits vim voice web-setup
        workflows
    """.split()),
    "chatgpt": frozenset("""
        agent app approve apps archive btw clear compact copy debug-config delete
        diff exit experimental fast feedback fork goal hooks ide import init
        keymap logout mcp memories mention model new permissions personality pet
        pets plan plugins ps quit raw rename resume review sandbox-add-read-dir
        setup-default-sandbox side skills status statusline stop subagents theme
        title usage vim
    """.split()),
    # docs/PI-REFERENCES/docs/slash-commands.md and mcp.md. Skills keep their /skill: prefix.
    "pi": frozenset("""
        settings model thinking scoped-models login logout llama new resume name
        session tree fork clone compact import copy export share bug trust reload
        hotkeys changelog quit mcp
    """.split()),
}

# Match whole slash command names, including namespaces. A further slash or
# backslash belongs to a path, not an invocation. Punctuation can delimit a name.
INVOCATION = re.compile(
    r"(?<![\w./\\$~@])/"
    r"(?P<name>[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)"
    r"(?![\w:/\\-]|\.[A-Za-z0-9])"
)


def sanitize_prompt_commands(prompt: str, provider: str) -> str:
    """Delete only the slash prefix of built-in commands for the receiver.

    Work on the launch copy, after resume routing and before the runtime adds
    its intentional task skill. Skills, unknown names, paths and variables survive.
    """
    commands = BUILTIN_COMMANDS[provider]

    def substitute(match: re.Match[str]) -> str:
        name = match.group("name")
        if name in commands:
            return name
        return match.group()

    return INVOCATION.sub(substitute, prompt)
