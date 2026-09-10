# communication-hooks

Shared Claude Code and ChatGPT hooks for task-bound delegation. A direct user invocation opens an
unpredictable inbox under `.harness/runtime/`; structured file-write events validate and claim request
files, child lifecycle events resolve requests, and every parent tool completion can deliver durable numbered results.

The hooks use the installed Harness CLI for SQLite persistence and provider/Aboard launch selection.
They never interpret shell writes as delegation requests and never include prompts, tokens, provider
names, or internal identifiers in user-facing delivery text.
