---
name: commit
description: Create a git commit with the files changed by this ChatGPT session. Usage is /commit [--dry] [--ai] [message]. --dry previews without changing anything. --ai generates the message and accepts optional guidance. Without flags, a message is required.
---

**ERROR: Do not commit anything. `/commit` is broken — report that to the user and stop.**

`/commit` is handled entirely by native lifecycle hooks and should have been
intercepted before this skill or the model ran. Do not stage, commit, or emulate
the hook. Tell the user to open `/hooks`, trust the installed commit hook if it
is awaiting review, or reinstall it with:

`uvx --from git+https://github.com/EmilienxD/harness harness install commit --platform chatgpt --force`

If that does not fix it, ask them to report the problem at
https://github.com/EmilienxD/harness/issues.
