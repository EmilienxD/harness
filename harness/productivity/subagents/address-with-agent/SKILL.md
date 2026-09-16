---
name: address-with-agent
description: Launch a visible agent to implement and validate a bounded change. Use when the user wants a separate agent to perform the work.
argument-hint: "[implementation task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Address a Change with an Agent

The user wants to launch one or more agents to implement something. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the work from the user's request and the preceding conversation. When the invocation provides no new instructions, use the subject already under discussion and any description supplied as an argument. If neither the invocation nor prior messages establishes what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: implement                       # Required fixed value. This selects the address-this workflow; it is not the request's name.
mode: interactive|auto                # Required. These are the only valid modes.
provider: claude|chatgpt              # Optional. Set only when the user requests a provider; otherwise omit it.
---

<prompt for the new agent>
```

The request filename may be any descriptive Markdown filename. It does not change the fixed `task: implement` authorization.

- Use `interactive` when the user wants to work with the agent directly in its visible session.
- Use `auto` when the agent should finish independently and report back to you. Default to `auto` when the user does not ask to interact with it directly.

A new call starts a fresh agent with no conversation context beyond project memory files such as AGENTS.md and CLAUDE.md. Make the prompt self-contained: state the desired outcome, relevant context and files, constraints, and validation expectations. The system invokes `address-this` automatically, so do not put a skill invocation in the prompt.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Refer to line numbers in plain text rather than appending them to the path. If relevant information is not persisted in the codebase, include it directly in the prompt.

For an interactive agent, address it as though the user were sending its first message. For an auto agent, address it as another agent working on your behalf and ask it to report the completed result.

The new agent runs in another visible session. An interactive agent can reply after the user asks it to send a response back; an auto agent replies automatically when it finishes. A hook will notify you when it finishes. Do not sleep, poll, or proactively check its progress; continue with other work or respond to the user.
