---
name: ask-agent-to-prototype
description: Launch a visible agent to build a focused prototype. Use when the user wants a separate agent to test an idea through a disposable implementation.
disable-model-invocation: true
---

# Ask an Agent to Prototype

The user wants to launch one or more agents to prototype. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the task from the user's request and the preceding conversation: when the invocation provides no new task, use the subject already under discussion and/or what the description the user provided as an argument if any. If neither the invocation nor prior messages establish what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: prototype                       # Required. The system starts the agent with the prototype skill based on this parameter.
mode: interactive|auto               # Required. Choose based on who should interact with the new agent.
provider: claude|chatgpt              # Optional. Set it only when the user requests a specific provider. It defaults to the provider used by your session if omitted.
---

<prompt for the new agent>
```

- Use `interactive` when the user wants to guide and evaluate the prototype directly in the agent's visible session.
- Use `auto` when the agent should build and assess the prototype independently, then report back to you. Default to `auto` when the user does not ask to interact with it directly.

A new call starts a fresh agent with no context from prior runs beyond project memory files such as AGENTS.md and CLAUDE.md. The prompt must therefore be self-contained without re-explaining general project information. Clearly describe the agent's task—why, what, where, and how—because it is not aware of the user's intent. The system invokes the `prototype` skill automatically, so do not put a skill invocation in the prompt.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported. If the user provided code that is not persisted in the codebase, include the relevant parts in the prompt as small code snippets.

Personality change:
- An interactive agent speaks directly with the user, so address it as though you were the user sending its first message. Do not say, "The user wants to ..." Say, "It has been decided to ..." (neutral, preferred) or, "I want to ..." (when first person is more appropriate).
- An auto agent speaks with you, the caller. Address it as another agent working on your behalf: explain what the user needs, define the prototype and its boundaries, and ask it to report the result back to you.

Interactive example:

```markdown
---
task: prototype
mode: interactive
---

It has been decided to test a compact command palette for @src/ui. Build a disposable prototype with me so we can evaluate keyboard navigation, grouping, and empty states.
```

Auto example:

```markdown
---
task: prototype
mode: auto
---

The user wants evidence that a command palette would simplify navigation. Build a disposable prototype against @src/ui, exercise keyboard navigation and empty states, and report what the experiment demonstrates. Keep production code unchanged.
```

In real scenarios, provide more details in the prompt.

The new agent runs in another visible session. An interactive agent can reply to you after the user requests that it send a response back to this session; an auto agent replies automatically when it finishes. You will be notified automatically when it finishes via a hook. Do NOT sleep, poll, proactively check its progress, or run any command yourself to do so. Continue with other work or respond to the user instead.
