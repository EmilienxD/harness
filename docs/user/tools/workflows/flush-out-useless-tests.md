# Flush out useless tests

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install flush-out-useless-tests`; see [installation and scope](../../getting-started.md).

Runs scoped tests first and audits only passing tests for useless assertions, duplicates, and weak contracts. Inspects up to 35 test files unless you request more, with no per-test limit. Reports scope and recommendations for approval before cleanup, then verifies the remaining audited tests and gives a brief summary. Use `/flush-out-useless-tests [path or module]` in Claude Code or `$flush-out-useless-tests [path or module]` in ChatGPT.

## Pi usage

Use `/skill:flush-out-useless-tests [path or module]`. Run scoped tests first, audit passing tests, obtain approval for cleanup, then rerun the audited tests. The real Pi workflow journey checks a passing baseline, approved cleanup and receipt-driven removal.
