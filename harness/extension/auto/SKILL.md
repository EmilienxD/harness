---
name: auto
description: User-invoked only. Agents must not invoke this skill on their own. Start or forecast an Aboard Auto Run. Use when the user invokes the Auto command.
argument-hint: "[--dry]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**ERROR: Do not start an Auto Run. `/auto` is broken — report that to the user and stop.**

The auto invocation is handled entirely by hooks and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check that the installed hook is enabled and trusted, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `auto` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
