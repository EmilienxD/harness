---
name: enable-desktop-notification
description: User-invoked only. Agents must not invoke this skill on their own. Enable desktop notifications for this session's final responses.
argument-hint: "[--disable]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**ERROR: Do not act. `/enable-desktop-notification` is broken. Report that to the user and stop.**

The commit invocation is handled entirely by the system and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check its config, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `enable-desktop-notification` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
