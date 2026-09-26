# Mid-prompt skills

## Use it

`mid-prompt-skills` is a Claude Code hook. Once installed, it expands an invocable skill even when `/skill-name` appears after other text in your message. For example, `Review this change /decisions` can invoke the skill; no separate command is needed.

## What happens

Arguments run from the skill mention to the end of its line or the next skill mention. The hook skips fenced code, skills Claude already expanded, skills disabled in `skillOverrides`, and skills marked `user-invocable: false` or `context: fork`. It searches managed, personal, and project skills and `.claude/commands/`. Plugin skills and skills from `--add-dir` are outside its search. It cannot reproduce shell injection in skill content or frontmatter controls such as `allowed-tools` and `model`; place a skill at the beginning of the prompt when those features matter.

## Practical note

If a mid-message invocation stays plain text, confirm that the skill is directly invocable and stored in one of the searched locations. Put examples containing `/skill-name` in fenced code blocks when you want them treated as examples rather than invocations.
