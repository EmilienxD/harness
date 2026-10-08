# Handoff grilling

## Use it

Use `/handoff-grilling` in Claude Code or `$handoff-grilling` in ChatGPT when a `grill-me` discussion will continue in another session. You can append the next session's focus.

## What happens

The skill writes a detailed document in the operating system's temporary directory. It preserves the initial request, decisions and their rationale, rejected alternatives, open questions, evidence, and next steps. It references existing artifacts by path or URL. Secrets are redacted, including in the quoted initial request when necessary. Pass the document to the next agent.

## Practical note

The handoff distinguishes confirmed facts, user choices, accepted recommendations, and unverified inferences. Its initial-request quote stays verbatim except for any secret value that must be redacted. Use the regular `handoff` skill when a compact continuation summary is enough.
