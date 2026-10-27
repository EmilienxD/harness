---
name: copy-message-as-issue
description: Copy the latest completed assistant response directly into a GitHub issue. Run copy-message-as-issue after reviewing the response; the hook publishes it without a model call or an issue draft.
disable-model-invocation: true
---

**WARNING**: If you are reading these instructions but the user did not invoke this skill, you have bypassed the user-invocation-only rule and are reading this file by mistake. In that case, skip the instructions below and continue as if you had never discovered this skill yourself.

**ERROR**: If the user invoked this skill but you still reached these instructions, do not act. `/copy-message-as-issue` is broken. Report that to the user and stop.**

The copy-message-as-issue invocation is handled entirely by the system and should have been intercepted before reaching you.

Do not try fixing it or finding a workaround; tell the user to check its config, or to reinstall it with `uvx --from git+https://github.com/EmilienxD/harness harness` and reselect `copy-message-as-issue` in the catalogue.

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
