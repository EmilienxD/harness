---
name: setup-command-aliases
description: Developer-invoked only. Agents must not invoke this skill on their own. Add or change cross-platform shell command aliases when the developer asks for a new alias or shortcut command.
argument-hint: "[alias request]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Add or modify command aliases in the developer's shell configuration files.

## Platform Detection

Detect the platform and update the appropriate files:

**Windows:**
- PowerShell: `$PROFILE` (typically `C:\Users\<username>\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`)
- Git Bash: `~/.bashrc`

**macOS/Linux:**
- Bash: `~/.bashrc` or `~/.bash_aliases` (check which exists, prefer `~/.bash_aliases` if both exist)
- Zsh: `~/.zshrc`

## Syntax by Shell

**PowerShell:**
```powershell
function aliasname { command $args }
```

**Bash/Zsh:**
```bash
alias aliasname='command'
```

## Instructions

1. **Read the existing file** to preserve other content and check for conflicts.
2. **Check for duplicates**: If the alias already exists, ask whether to replace it.
3. **Verify the target command**: Check that the executable is installed and supports the requested options.
4. **Add the alias**:
   - For PowerShell: Add as a function with `$args` to pass arguments
   - For Bash/Zsh: Add as an alias with single quotes
5. **Append to the end** of the file, keeping existing content intact.
6. **Report the alias and exact command it runs**, and how to activate it:
   - PowerShell: `. $PROFILE` or restart terminal
   - Bash: `source ~/.bashrc` or restart terminal
   - Zsh: `source ~/.zshrc` or restart terminal

## Examples

Request: "Add alias `ll` for `ls -la`"
- PowerShell: `function ll { ls -la $args }`
- Bash/Zsh: `alias ll='ls -la'`

Request: "Add alias `gs` for `git status`"
- PowerShell: `function gs { git status $args }`
- Bash/Zsh: `alias gs='git status'`

Request: "Add alias `dc` for `docker-compose`"
- PowerShell: `function dc { docker-compose $args }`
- Bash/Zsh: `alias dc='docker-compose'`

## Multi-platform Requests

When the developer asks for "cross-platform" or mentions multiple shells, update all applicable files for their system:
- On Windows: Update both PowerShell profile and `~/.bashrc` (for Git Bash)
- On macOS/Linux: Update both `~/.bashrc` and `~/.zshrc` (if both shells are used)

## Notes

- CMD.exe is not supported (no persistent alias mechanism)
- Always preserve existing content in config files
- Use `$args` in PowerShell functions to forward arguments to the underlying command
- Use single quotes in Bash/Zsh aliases to prevent variable expansion
