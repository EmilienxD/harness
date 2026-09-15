---
name: publish-issues
description: Publish or explicitly clean drafts in .issues-gateway/ through the installed lifecycle hook. Supports --dry, --discard-current, and --gc --older-than <duration>. Explicit invocation only.
disable-model-invocation: true
---

**ERROR: Do not publish anything. `/publish-issues` is broken — report that to the user and stop.**

The publish-issues invocation is handled entirely by hooks and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check that the installed hook is enabled and trusted, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `issue-writers` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.


