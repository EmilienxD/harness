# no-new-documents

A cross-platform `PreToolUse` guard that lets an agent modify existing files,
but prevents it from creating new files inside configured documentation
directories.

The default configuration protects every directory named `docs` anywhere in
the project. When the hook denies a creation, its feedback tells the agent to
continue the rest of the task and, in its final response, ask the user whether
the intended document should be added and explain why it wanted to add it.

## Configuration

Harness installs an editable starter file beside the hook:

- Claude Code: `.claude/hooks/no-new-documents.toml`
- ChatGPT/Codex: `.codex/hooks/no-new-documents.toml`

```toml
paths = ["docs"]
max_depth = -1
```

Add as many project-relative directory paths as needed:

```toml
paths = ["docs", "project-notes", "architecture/decisions"]
max_depth = -1
```

Each configured path identifies a directory and everything below it. A path is
matched wherever that directory sequence occurs in the project. `max_depth`
limits how many directory segments may appear before it: `0` matches only at
the project root, `1` also matches one level below, and `-1` allows any depth.
Harness marks this file as a starter, so reinstalling or upgrading the package
does not overwrite local changes.

## Coverage

On Claude Code, the hook inspects `Write`, `Bash`, and `PowerShell`. On
ChatGPT/Codex, it inspects `apply_patch` and `Bash`. It denies a structured
write only when the target does not already exist, and denies `apply_patch`
only for an explicit `*** Add File` section. Existing files remain editable.

Shell detection is intentionally conservative. It recognizes explicit output
redirection, a single literal `touch` target, and PowerShell's explicit
`New-Item`, `Set-Content`, `Add-Content`, and `Out-File` path parameters. It
then checks that the literal target is both protected and absent. It ignores
paths using variables, globs, or a command that first changes directory. This
avoids guessing and false positives, but means the hook is a workflow guardrail
rather than an operating-system security boundary.

Malformed or unreadable configuration is ignored rather than broadening the
block beyond paths the user explicitly configured.

## Installation

Run the Harness catalogue, select `no-new-documents`, choose the project or
user scope, and enable Claude Code, ChatGPT, or both. Restart the agent after
installation so it reloads its hooks.

The hook uses only the Python standard library. Harness resolves and records a
working Python interpreter in the installed hook registration.
