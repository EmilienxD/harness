---
name: work-with-agent
description: Launch a visible general-purpose agent for a delegated task. Use when the user wants a separate agent to handle work that does not fit a more specific delegation skill.
disable-model-invocation: true
---

# Work with an Agent

The user wants to launch one or more general-purpose agents. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the task from the user's request and the preceding conversation: when the invocation provides no new task, use the subject already under discussion and/or what the description the user provided as an argument if any. If neither the invocation nor prior messages establish what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: general                         # Required. The system sets the agent role and permissions based on this parameter.
mode: interactive|auto               # Required. Choose based on who should interact with the new agent.
provider: claude|chatgpt              # Optional. Set it only when the user requests a specific provider. It defaults to the provider used by your session if omitted.
---

<prompt for the new agent>
```

- Use `interactive` when the user wants to work with the agent directly in its visible session.
- Use `auto` when the agent should complete the task independently and report back to you. Default to `auto` when the user does not ask to interact with it directly.

A new call starts a fresh agent with no context from prior runs beyond project memory files such as AGENTS.md and CLAUDE.md. The prompt must therefore be self-contained without re-explaining general project information. Clearly describe the agent's task—why, what, where, and how—because it is not aware of the user's intent.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported. If the user provided code that is not persisted in the codebase, include the relevant parts in the prompt as small code snippets.

Personality change:
- An interactive agent speaks directly with the user, so address it as though you were the user sending its first message. Do not say, "The user wants to ..." Say, "It has been decided to ..." (neutral, preferred) or, "I want to ..." (when first person is more appropriate).
- An auto agent speaks with you, the caller. Address it as another agent working on your behalf: explain what the user needs, give it a bounded task, and ask it to report the result back to you.

Interactive example:

```markdown
---
task: general
mode: interactive
---

It has been decided to simplify the configuration API in @src/config. Help me evaluate the current design and decide which compatibility constraints the new API should preserve.
```

Auto example:

```markdown
---
task: general
mode: auto
---

The user wants to understand why configuration precedence differs between the two adapters. Inspect @src/config and report the cause, the affected paths, and the safest correction. Do not make changes.
```

In real scenarios, provide more details in the prompt.

The new agent runs in another visible session. An interactive agent can reply to you after the user requests that it send a response back to this session; an auto agent replies automatically when it finishes. You will be notified automatically when it finishes via a hook. Do NOT sleep, poll, proactively check its progress, or run any command yourself to do so. Continue with other work or respond to the user instead.
