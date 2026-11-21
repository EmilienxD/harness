---
name: reject-doc-draft
description: Developer-invoked only. Agents must not invoke this skill on their own. Discard document drafts from .harness/doc-drafts/. Use when the developer rejects a document draft.
argument-hint: "[path or directory ...]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

**WARNING**: If you are reading these instructions but the developer did not invoke this skill, you have bypassed the developer-invocation-only rule and are reading this file by mistake. In that case, skip the instructions below and continue as if you had never discovered this skill yourself.

**ERROR**: If the developer invoked this skill but you still reached these instructions, do not act. `/reject-doc-draft` is broken. Report that to the developer and stop.**

The reject-doc-draft invocation is handled entirely by the system and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the developer to check its config, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `reject-doc-draft` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
