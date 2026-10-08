# Writing for agents

## Use it

Invoke `/writing-for-agents` in Claude Code or `$writing-for-agents` in ChatGPT to write or revise an agent-facing document, such as `SKILL.md`, `AGENTS.md`, or `CLAUDE.md`. Specify the document and intended behavior, for example `$writing-for-agents revise the review skill to cover database changes`.

## What happens

The skill guides invocation wording, information hierarchy, completion criteria, progressive disclosure, and pruning. For a skill file, it also consults its companion `SKILL-MECHANICS.md` for frontmatter and invocation design. Its aim is a document that reliably leads the agent through the intended process without carrying stale or repeated instructions.

## Practical note

Give the agent the task that should trigger the document and what completion looks like. The skill treats a skill description or an `AGENTS.md` reference as the pointer that determines when deeper instructions are read. It encourages one clear source for each rule and placing branch-specific detail behind a reference when appropriate.
