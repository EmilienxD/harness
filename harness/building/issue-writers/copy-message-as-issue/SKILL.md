---
name: copy-message-as-issue
description: Copy the latest completed assistant response directly into a GitHub issue. Run copy-message-as-issue after reviewing the response; the hook publishes it without a model call or an issue draft.
disable-model-invocation: true
---

**ERROR: Do not create an issue. `copy-message-as-issue` is broken — report that to the user and stop.**

The copy-message-as-issue invocation is handled entirely by a provider hook and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check that the installed hook is enabled and trusted, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `issue-writers` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
