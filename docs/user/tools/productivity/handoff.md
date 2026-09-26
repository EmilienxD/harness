# Handoff

## Use it

Invoke `/handoff` in Claude Code or `$handoff` in ChatGPT before moving work to another agent or session. Add a next-session focus if useful, for example `$handoff finish the migration checks`.

## What happens

The skill writes a handoff document in your operating system's temporary directory. It summarizes the conversation, points to existing plans, commits, or diffs instead of copying them, and redacts sensitive information. Give the generated document to the receiving agent. For a `grill-me` design discussion whose reasoning trail must be preserved, use `handoff-grilling`.

## Practical note

The optional text after the invocation sets the receiving session's focus. Keep referenced artifacts available to the next agent; the handoff intentionally points to them rather than embedding their full contents. Check the generated document's path before ending the original session.
