---
name: copy-message-as-issue
description: Copy Claude's latest completed message into a GitHub issue titled Report with the session ID and generated session title. Run /copy-message-as-issue after reviewing the response; the hook publishes it without a model call.
disable-model-invocation: true
---

**ERROR: `/copy-message-as-issue` was not intercepted by its hook. Report the failure and stop.**

Do not create an issue or emulate the hook. It publishes the cached final response and
tracks retries to avoid duplicates. Tell the user to reinstall the issues pack with
rerun `uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness` and reselect `issues`,
then finish a Claude response before invoking `/copy-message-as-issue` again.
