---
name: websearch-with-agent
description: Launch a visible agent to research the web and report sourced findings. Use when the user wants a separate agent to investigate current or externally documented information.
disable-model-invocation: true
---

# Web Search with an Agent

The user wants to launch one or more agents to research the web. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the task from the user's request and the preceding conversation: when the invocation provides no new task, use the subject already under discussion and/or what the description the user provided as an argument if any. If neither the invocation nor prior messages establish what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: websearch                       # Required. The system starts the agent with the websearch skill based on this parameter.
mode: interactive|auto               # Required. Choose based on who should interact with the new agent.
provider: claude|chatgpt              # Optional. Set it only when the user requests a specific provider. It defaults to the provider used by your session if omitted.
---

<prompt for the new agent>
```

- Use `interactive` when the user wants to direct the research and discuss findings with the agent in its visible session.
- Use `auto` when the agent should research independently and report its findings back to you. Default to `auto` when the user does not ask to interact with it directly.

A new call starts a fresh agent with no context from prior runs beyond project memory files such as AGENTS.md and CLAUDE.md. The prompt must therefore be self-contained without re-explaining general project information. Clearly describe the agent's task—why, what, where, and how—because it is not aware of the user's intent. Include the research question, relevant constraints, desired sources, and expected output. The system invokes the `websearch` skill automatically, so do not put a skill invocation in the prompt.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported. If the user provided code that is not persisted in the codebase, include the relevant parts in the prompt as small code snippets.

Personality change:
- An interactive agent speaks directly with the user, so address it as though you were the user sending its first message. Do not say, "The user wants to ..." Say, "It has been decided to ..." (neutral, preferred) or, "I want to ..." (when first person is more appropriate).
- An auto agent speaks with you, the caller. Address it as another agent working on your behalf: explain what the user needs, give it the bounded research question, and ask it to report sourced findings back to you.

Interactive example:

```markdown
---
task: websearch
mode: interactive
---

I want to compare the current retry recommendations from the maintainers of the HTTP libraries used by @src/client. Research their official documentation with me and help me decide which guidance applies to our design.
```

Auto example:

```markdown
---
task: websearch
mode: auto
---

The user needs the current retry recommendations from the maintainers of the HTTP libraries used by @src/client. Research primary official sources, compare the guidance relevant to our design, and report concise findings with direct citations.
```

In real scenarios, provide more details in the prompt.

The new agent runs in another visible session. An interactive agent can reply to you after the user requests that it send a response back to this session; an auto agent replies automatically when it finishes. You will be notified automatically when it finishes via a hook. Do NOT sleep, poll, proactively check its progress, or run any command yourself to do so. Continue with other work or respond to the user instead.
