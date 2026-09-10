# Command Aliases

Cross-platform shell command alias manager for Claude Code and ChatGPT.

## Description

This skill helps users create and manage command aliases across different shells:
- **Windows**: PowerShell and Git Bash
- **macOS/Linux**: Bash and Zsh

## Usage

Invoke this skill when the user asks to:
- Create a command alias or shortcut
- Add an abbreviation for a command
- Set up a shell function

## Examples

```
"Add alias cc for claude"
"Create shortcut gs for git status"
"Make ll run ls -la"
"Add these aliases: dc for docker-compose, k for kubectl"
```

## What it does

- Detects the user's platform and shell
- Updates the appropriate configuration files
- Preserves existing content
- Checks for duplicate aliases
- Provides activation instructions

## Platform Support

- Windows: PowerShell profile + Git Bash `.bashrc`
- macOS: Bash `.bashrc` + Zsh `.zshrc`
- Linux: Bash `.bashrc` + Zsh `.zshrc`

CMD.exe is not supported as it lacks a persistent alias mechanism.
