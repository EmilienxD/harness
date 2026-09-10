# command-guard

A cross-platform `PreToolUse` hook that denies configured dangerous shell
commands before they run. It supports Claude Code and ChatGPT/Codex on Windows,
macOS, and Linux, and scans both POSIX-shell and PowerShell syntax regardless of
which operating system hosts the agent.

## What it blocks

The starter policy covers:

- deletion of `/`, home directories, `/Users`, Windows drive roots, user
  profiles, `C:\Users`, and whole UNC shares;
- raw-disk writes, filesystem formatting, and disk erase/initialization tools
  on macOS, Linux, and Windows;
- `sudo rm`, shell fork bombs, and network downloads piped directly into Bash,
  `sh`, or PowerShell's `Invoke-Expression`;
- forced Git pushes (while leaving `--force-with-lease` allowed), remote ref
  deletion, and destruction of reflog recovery data;
- system-wide ownership or permission changes with POSIX or Windows tools;
- irreversible GitHub CLI operations and token output; and
- password managers, secret-key export, macOS Keychain, Linux secret stores,
  Windows Credential Manager, and PowerShell secret vaults.

This is a guardrail, not a shell parser or a security sandbox. Regex matching
can have false positives and can be evaded through sufficiently indirect or
obfuscated commands. Keep the agent's normal OS permissions and approval
controls enabled.

## How it works

Harness installs one dependency-free Python hook and an adjacent
`command-guard.rules` file. Every matching shell tool call sends JSON to the
hook on standard input. The hook scans `tool_input.command` and returns
`permissionDecision: "deny"` on the first matching rule. Allowed commands
produce no output and run normally.

Claude Code registers the hook with `Bash|PowerShell`, because Windows Claude
installations can expose PowerShell as a distinct tool. ChatGPT/Codex currently
reports shell and unified `exec_command` calls to hooks through the `Bash`
matcher; the command text can still contain PowerShell.

The policy is loaded on every tool call, so edits apply immediately without a
restart. A missing, unreadable, or invalid policy fails closed and denies the
command with a repair instruction. Malformed hook input is ignored because
there is no valid command to inspect.

## Editing the policy

For a project install, edit:

- Claude Code: `.claude/hooks/command-guard.rules`
- ChatGPT/Codex: `.codex/hooks/command-guard.rules`

User-scope installs place the same files under the corresponding user config
directory. The rules file is a Harness starter file: reconciliation creates it
only when absent and never overwrites your edits.

The format is one POSIX-ERE-style regular expression per line. Empty lines and
comments beginning with `#` are ignored. Matching is case-insensitive, and
`[:space:]` is translated for Python's regular-expression engine. Add a
numbered heading before custom groups so denials can name the category without
echoing the command or regex, which might contain sensitive text:

```text
# 16. organization-specific production deletion
(^|[;&|[:space:]])acme[[:space:]]+production[[:space:]]+destroy([[:space:]]|$)
```

Test narrowly around every custom rule: include commands that must be denied
and similar commands that must remain allowed. A bad regex blocks all shell
commands until it is corrected, by design.

## Installation

Run the pinned Harness installer and select `command-guard` in the catalogue:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.3 harness
```

Choose project or user scope and Claude Code, ChatGPT, or both. Harness copies
the files and merges the native hook registration without disturbing unrelated
settings. A working Python 3 is required at installation time; Harness resolves
and records the interpreter command for the selected product.
