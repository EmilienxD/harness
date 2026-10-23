# Test-driven development

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install tdd`; see [installation and scope](../../getting-started.md).

## When to use

Use `tdd` for features, bug fixes, or integration tests that should be built test-first. It is model-invoked when relevant and can also be requested explicitly.

## Invocation

Use `/tdd <feature or bug>` in Claude Code or `$tdd <feature or bug>` in ChatGPT. Include the observable behavior you expect.

## What happens

The agent tests critical paths and complex logic through public interfaces. It writes one failing test, adds only enough implementation to pass it, and repeats in vertical slices. Tests should use independent expected values and survive internal refactors; the skill rejects implementation-coupled and tautological tests. Refactoring belongs to review after the red-green loop.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. The package installs `SKILL.md`, `tests.md`, and `mocking.md`, but no test runner or project configuration. The agent uses existing project tests, ADRs, and `CONTEXT.md` when present.

## Example

`/tdd Add validation for an empty checkout cart` begins with a failing behavior test at the public checkout boundary.

## Pi usage

Use `/skill:tdd`. The shared behavior-focused red/green workflow and references are installed unchanged. Use the project's real tests; discovery alone does not establish that a particular implementation satisfies them.
