# Prototype

## When to use

Use `prototype` when a small disposable implementation can answer a specific logic, state, or UI design question before committing to a production design.

## Invocation

Use `/prototype [design question]` in Claude Code or `$prototype [design question]` in ChatGPT. Name the decision the prototype should inform, or let the agent infer it from the surrounding task.

## What happens

The agent frames one question and chooses a logic or UI prototype. It builds the smallest runnable artifact that makes the answer visible, runs the decisive happy path and relevant edge cases, then puts it in front of you for feedback. The handoff gives the exact open or run instruction, what was observed, the limitations, and the decision the evidence supports.

## Files and prerequisites

Both providers are supported. The prototype lives in its own folder inside a dedicated repository workspace. The agent follows project scratch conventions or creates a top-level folder such as `prototypes/`; a `.gitignore` inside the workspace contains `*` so its contents stay out of version control. Dependencies and artifacts stay there, leaving project source files unchanged.

## Example

`/prototype Would this state model handle interrupted uploads?` asks for a runnable logic experiment and a conclusion tied to that case.
