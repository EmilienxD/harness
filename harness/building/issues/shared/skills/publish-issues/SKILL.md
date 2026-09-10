---
name: publish-issues
description: Publish all drafted issues from .issues-gateway/ to GitHub through the installed lifecycle hook. Supports --dry to preview without creating issues. Explicit invocation only.
disable-model-invocation: true
---

Use what the user provided alongside the invocation as this skill's input.

**ERROR: Do not publish anything. The `publish-issues` hook did not intercept the invocation — report that to the user and stop.**

`publish-issues` is handled entirely by a provider-specific lifecycle hook that should have intercepted the prompt. Do not run `gh issue create` or otherwise emulate what the hook would have done. The hook
deletes successfully published drafts and updates failed drafts before reruns, and a hand-rolled run would duplicate issues. Don't try fixing it yourself except if the user explicitly asks it in future messages. For now, notify the user and ask them to rerun `uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness`, reselect `issues`, or publish a GitHub issue at `https://github.com/EmilienxD/harness/issues`.


