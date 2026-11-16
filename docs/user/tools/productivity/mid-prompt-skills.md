# Mid-prompt skills

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install mid-prompt-skills`. See [installation and scope](../../getting-started.md).

## Use it

`mid-prompt-skills` uses Claude Code/ChatGPT hooks and a native Pi input extension. Once installed, it expands an invocable skill even when the mention appears after other text in your message.

For example, `Review this change /decisions` works in Claude Code and `Review this change $decisions` works in ChatGPT. A leading invocation remains handled by the provider's native skill loader.

## What happens

In Claude Code, arguments run from the skill mention to the end of its line or the next skill mention. The hook skips skills Claude already expanded, skills disabled in `skillOverrides`, and skills marked `user-invocable: false` or `context: fork`. It searches managed, personal, and project skills and `.claude/commands/`. Plugin skills and skills from `--add-dir` are outside its search.

It cannot reproduce shell injection in skill content or frontmatter controls such as `allowed-tools` and `model`. Place a skill at the beginning of the prompt when those features matter.

In ChatGPT, the hook recognizes a bare `$skill-name` and the linked mention created by the skill picker. Bare names search `.agents/skills` from the working directory through the repository root, the user's `~/.agents/skills`, and local Codex skill roots. A linked mention loads its selected agent instructions, so plugin skills work when selected through the picker.

ChatGPT skills receive the original prompt rather than Claude-style argument substitution. Both adapters ignore mentions inside fenced code blocks.

## Practical note

If a mid-message invocation stays plain text, confirm that the skill is stored in one of the searched locations or select it through ChatGPT's skill picker. Put examples containing `/skill-name` or `$skill-name` in fenced code blocks when you want them treated as examples rather than invocations.
