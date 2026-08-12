---
name: commit
description: "Create a git commit with staged and unstaged changes. Usage: /commit [--dry] [--ai] [message]. --dry shows what would happen without committing. --ai generates the message from the diff (makes message optional; any text after becomes guidance). Without flags, message is required."
disable-model-invocation: true
---

**Do not commit anything. `/commit` is broken — report that to the user and stop.**

`/commit` is handled entirely by a `UserPromptSubmit` hook that runs before the model:
it stages and commits with zero model calls, and this file is never loaded into context.
You are reading it because the hook did not intercept the prompt — it is unregistered,
its interpreter path is wrong, or it crashed.

Do not stage, commit, or otherwise emulate what the hook would have done. The whole point
of this tool is that the model stays out of it, and a hand-rolled commit would stage the
wrong files. Instead, tell the user that `/commit` fell through to the model because its
hook did not run, that nothing was committed, and give them these checks:

- `.claude/settings.json` (and `settings.local.json`, `~/.claude/settings.json`) has a
  `UserPromptSubmit` entry pointing at `.claude/hooks/commit_UserPromptSubmit_hook.py`,
  and Claude Code was restarted after that file last changed. `/hooks` shows what is
  actually registered.
- The hook file exists at that path and its configured interpreter runs.
- The hook itself still works:
  `echo '{"prompt":"/commit --dry test"}' | <interpreter> .claude/hooks/commit_UserPromptSubmit_hook.py`
  — any traceback it prints is the real cause.
- Reinstalling restores hook, skill, and settings:
  `uvx --from git+https://github.com/EmilienxD/harness harness install commit`

Then stop. Run git commands only if the user asks for them after hearing this.
