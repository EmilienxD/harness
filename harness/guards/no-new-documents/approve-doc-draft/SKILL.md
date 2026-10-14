---
name: approve-doc-draft
description: User-invoked only. Agents must not invoke this skill on their own. Move reviewed document drafts from .harness/doc-drafts/ to the paths they mirror. Use when the user approves a document draft.
argument-hint: "[path or directory ...]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**ERROR: Do not move any draft. `/approve-doc-draft` is broken — report that to the user and stop.**

The approve-doc-draft invocation is handled entirely by the installed hook or Pi extension and should have been intercepted before reaching you.

Tell the user to check that the installed hook or extension is enabled and trusted, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `no-new-documents` in the catalogue. Keep the draft in place until the command works.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
