---
name: publish-issues
description: "Publish all drafted issues from .issues-gateway/ to GitHub. Usage: /publish-issues [--dry]. --dry shows what would be published without creating issues. Creates issues via gh CLI and tracks published issues to avoid duplicates on rerun."
disable-model-invocation: true
---

**Do not publish anything. `/publish-issues` is broken — report that to the user and stop.**

`/publish-issues` is handled entirely by a `UserPromptSubmit` hook that runs before the
model: it creates the issues with zero model calls, and this file is never loaded into
context. You are reading it because the hook did not intercept the prompt — it is
unregistered, its interpreter path is wrong, or it crashed.

Do not run `gh issue create`, and do not otherwise emulate what the hook would have done.
It tracks which drafts were already published, and a hand-rolled run would duplicate
issues. Instead, tell the user that `/publish-issues` fell through to the model because
its hook did not run, that nothing was published, and give them these checks:

- `.claude/settings.json` (and `settings.local.json`, `~/.claude/settings.json`) has a
  `UserPromptSubmit` entry pointing at
  `.claude/hooks/publish_issues_UserPromptSubmit_hook.py`, and Claude Code was restarted
  after that file last changed. `/hooks` shows what is actually registered.
- The hook file exists at that path and its configured interpreter runs.
- The hook itself still works:
  `echo '{"prompt":"/publish-issues --dry"}' | <interpreter> .claude/hooks/publish_issues_UserPromptSubmit_hook.py`
  — any traceback it prints is the real cause.
- Reinstalling restores hooks, skills, and settings:
  `uvx --from git+https://github.com/EmilienxD/harness harness install issues`

Then stop. Publish only if the user asks for it after hearing this.
