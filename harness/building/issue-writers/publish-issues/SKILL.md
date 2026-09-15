---
name: publish-issues
description: Publish all drafted issues from .issues-gateway/ to GitHub through the installed lifecycle hook. Supports --dry to preview without creating issues. Explicit invocation only.
disable-model-invocation: true
---

**ERROR: Do not publish anything. `/publish-issues` is broken — report that to the user and stop.**

The publish-issues invocation is handled entirely by hooks and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check that the installed hook is enabled and trusted, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `issue-writers` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.


