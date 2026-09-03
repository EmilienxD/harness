---
name: publish-issues
description: Publish all drafted issues from .issues-gateway/ to GitHub. Usage is /publish-issues [--dry]. --dry shows what would be published without creating issues. Creates issues via gh CLI and deletes successful drafts to avoid duplicates on rerun.
disable-model-invocation: true
---

**ERROR: Do not publish anything. `/publish-issues` is broken; report that to the user and stop.**

`/publish-issues` is handled entirely by a `UserPromptSubmit` hook that should have intercepted the prompt; it is either unregistered or not working there. Do not run `gh issue create`, or otherwise emulate what the hook would have done. The hook
deletes successfully published drafts and updates failed drafts before reruns, and a hand-rolled run would duplicate issues. Don't try fixing it yourself except if the user explicitly asks it in future messages. For now, just notify the user of this problem and ask him to run `uvx --from git+https://github.com/EmilienxD/harness harness install issues --force` to reinstall the tool or to publish a Github issue to `https://github.com/EmilienxD/harness/issues`.
