---
name: commit
description: User-invoked only. Agents must not invoke this skill on their own. Commit the files changed during the current session. Use when the user requests a commit, generated message, or dry-run preview.
argument-hint: "[--dry | --ai [guidance] | <message>]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**WARNING**: If you are reading these instructions but the user did not invoke this skill, you have bypassed the user-invocation-only rule and are reading this file by mistake. In that case, skip the instructions below and continue as if you had never discovered this skill yourself.

**ERROR**: If the user invoked this skill but you still reached these instructions, do not act. `/commit` is broken. Report that to the user and stop.**

The commit invocation is handled entirely by the system and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check its config, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `commit` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
