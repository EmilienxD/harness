---
name: approve-doc-draft
description: User-invoked only. Agents must not invoke this skill on their own. Move reviewed document drafts from .harness/doc-drafts/ to the paths they mirror. Use when the user approves a document draft.
argument-hint: "[path or directory ...]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**ERROR: Do not act. `/approve-doc-draft` is broken. Report that to the user and stop.**

The approve-doc-draft invocation is handled entirely by the system and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check its config, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `approve-doc-draft` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
