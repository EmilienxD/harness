---
name: commit
description: Create a git commit with the files changed by the current session. Supports a dry-run preview, AI-generated messages with optional guidance, or an explicit commit message. Explicit invocation only.
disable-model-invocation: true
---

**ERROR: Do not commit anything. `/commit` is broken — report that to the user and stop.**

The commit invocation is handled entirely by provider-specific lifecycle hooks and should have been
intercepted before this skill or the model ran. Do not stage, commit, or emulate
the hook. Tell the user to check that the installed hook is enabled and trusted, or reinstall it with:

rerun `uvx --from git+https://github.com/EmilienxD/harness@v0.4.2 harness` and reselect `commit` in the catalogue

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
