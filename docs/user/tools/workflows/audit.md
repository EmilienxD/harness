# Audit

## When to use

Use `audit` for a read-only assessment of a codebase or selected path. It supports general, security, architecture, quality, performance, reliability, testing, dependencies, and privacy reviews.

## Invocation

Use `/audit [scope] [type] [agents=N] [focus]` in Claude Code or `$audit` with the same details in ChatGPT. An existing path limits scope; otherwise it uses the current codebase. `agents=none` requests a solo audit, while `agents=N` requests exactly N explorers.

## What happens

The agent first maps files, entry points, tests, and configuration within scope. It can partition larger scopes among non-overlapping explorer agents, then checks and ranks their findings. The report gives file-and-line evidence, impact, severity, confidence, remediation difficulty, and recommendations. It distinguishes evidenced problems from uncertain hypotheses.

## Files and prerequisites

Both providers are supported. The skill installs no project configuration. It does not edit code unless you separately ask for fixes. Explorer agents depend on the provider's available delegation tools.

## Example

`/audit src/auth security agents=none` requests a focused, solo security review of that path.
