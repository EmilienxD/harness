---
name: ask-agent-to-brainstorm
description: Launch a visible interactive agent to brainstorm a plan or design with the user. Use when the user wants a separate agent to question, clarify, or stress-test their thinking.
disable-model-invocation: true
---

# Ask an Agent to Brainstorm

The user wants to launch one or more agents to brainstorm. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the task from the user's request and the preceding conversation: when the invocation provides no new task, use the subject already under discussion and/or what the description the user provided as an argument if any. If neither the invocation nor prior messages establish what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: brainstorm            # Required. The system sets the agent role and permissions based on this parameter.
mode: interactive           # Required. This is the only supported mode for brainstorming.
provider: claude|chatgpt    # Optional. Set it only when the user requests a specific provider. It defaults to the provider used by your session if omitted.
---

<prompt for the new agent>
```

A new call starts a fresh agent with no context from prior runs beyond project memory files such as AGENTS.md and CLAUDE.md. The prompt must therefore be self-contained without re-explaining general project information. Clearly describe the agent's task—why, what, where, and how—because it is not aware of the user's intent.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported. If the user provided code that is not persisted in the codebase, include the relevant parts in the prompt as small code snippets.

Personality change: an interactive agent speaks directly with the user, so address it as though you were the user sending its first message. Do not say, "The user wants to ..." Say, "It has been decided to ..." (neutral, preferred) or, "I want to ..." (when first person is more appropriate).

Example:

```markdown
---
task: brainstorm
mode: interactive
---

The retry behavior needs a clear home in @src/client/library. Brainstorm with me to decide whether it belongs in the client or transport layer, focusing on ownership, failure semantics, and testability.
```

In real scenarios, provide more details in the prompt.

The new agent runs in another visible session. It can reply to you after the user requests that it send a response back to this session. You will be notified automatically when it finishes via a hook. Do NOT sleep, poll, proactively check its progress, or run any command yourself to do so. Continue with other work or respond to the user instead.
