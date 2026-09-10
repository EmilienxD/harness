---
name: commit
description: Create a git commit with staged and unstaged changes. Usage is /commit [--dry] [--ai] [message]. --dry shows what would happen without committing. --ai generates the message from the diff (makes message optional; any text after becomes guidance). Without flags, message is required.
disable-model-invocation: true
---

**ERROR: Do not commit anything. `/commit` is broken — report that to the user and stop.**

`/commit` is handled entirely by a `UserPromptSubmit` hook that should have intercepted the prompt — it is either unregistered or not working there. Do not stage, commit, or otherwise emulate what the hook would have done. The whole point of this tool is that the agent (you) stays out of it. Don't try fixing it yourself except if the user explicitly asks it in future messages. For now, notify the user and ask them to rerun `uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness`, reselect `commit`, or publish a GitHub issue at `https://github.com/EmilienxD/harness/issues`.
