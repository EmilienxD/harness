---
name: explore-with-agent
description: Launch a visible read-only agent to explore a codebase and report its findings. Use when the user wants a separate agent to investigate without making changes.
argument-hint: "[exploration task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Explore with an Agent

The user wants to launch one or more agents to explore. Launch each agent by creating one Markdown file at the inbox path provided by the hook. Writing a file there automatically launches that agent. If the preceding hook did not provide an inbox path, alert the user immediately and stop; do not attempt to launch an agent another way.

When the user requests multiple agents, create one request file per agent and write the files in parallel. The hook processes every written inbox file, so all requested agents can launch independently; do not combine multiple agents in one file.

Determine the task from the user's request and the preceding conversation: when the invocation provides no new task, use the subject already under discussion and/or what the description the user provided as an argument if any. If neither the invocation nor prior messages establish what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Use this request format:

```markdown
---
task: explore              # Required. The system sets the agent role and read-only permissions based on this parameter.
mode: auto                 # Required. This is the only supported mode for exploration.
provider: claude|chatgpt   # Optional. Set it only when the user requests a specific provider. It defaults to the provider used by your session if omitted.
---

<prompt for the new agent>
```

A new call starts a fresh agent with no context from prior runs beyond project memory files such as AGENTS.md and CLAUDE.md. The prompt must therefore be self-contained without re-explaining general project information. Clearly describe the agent's task—why, what, where, and how—because it is not aware of the user's intent.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported. If the user provided code that is not persisted in the codebase, include the relevant parts in the prompt as small code snippets.

Personality change: this is an auto agent, so it speaks with you, the caller. Address it as another agent working on your behalf: explain what the user needs, give it a bounded read-only investigation, and ask it to report its findings back to you.

Example:

```markdown
---
task: explore
mode: auto
---

The user reported that authentication refresh sometimes loops after a failed request. Explore @src/auth to trace the refresh path, identify likely loop conditions, and report the relevant files and evidence. Do not make changes.
```

In real scenarios, provide more details in the prompt.

The new agent runs in another visible session and returns its response automatically. You will be notified automatically when it finishes via a hook. Do NOT sleep, poll, proactively check its progress, or run any command yourself to do so. Continue with other work or respond to the user instead.
