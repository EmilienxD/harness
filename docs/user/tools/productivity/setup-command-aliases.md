# Setup command aliases

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install setup-command-aliases`. See [installation and scope](../../getting-started.md).

## Use it

Ask the agent to add a shell shortcut with `/setup-command-aliases` in Claude Code or `$setup-command-aliases` in ChatGPT, for example `$setup-command-aliases add gs for git status`.

## Configuration and requirements

On Windows, the skill edits the PowerShell profile and, for a cross-platform request, Git Bash's `~/.bashrc`. On macOS or Linux it uses Bash's `~/.bash_aliases` or `~/.bashrc`, and Zsh's `~/.zshrc` when applicable. It checks existing definitions and asks before replacing an alias.

It preserves other profile content, forwards arguments through PowerShell functions, and reports how to activate the change, usually by sourcing the profile or restarting the terminal. CMD aliases are outside its scope.

## What happens

The agent reads the existing shell file, checks for conflicts, and verifies that the target executable is installed and supports the requested options before appending the definition. It reports the alias, the exact command it runs, and how to activate it. For `gs` mapped to `git status`, PowerShell gets `function gs { git status $args }`. Bash and Zsh get `alias gs='git status'`.

Source the updated profile or open a new terminal before trying the alias.

## Pi usage

Use `/skill:setup-command-aliases [alias request]`. Preserve the existing PowerShell, Bash or Zsh configuration. A requested Pi wrapper is a shell alias, not a new provider installer action.
