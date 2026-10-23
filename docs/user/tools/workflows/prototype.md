# Prototype

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install prototype`; see [installation and scope](../../getting-started.md).

## When to use

Use `prototype` when a small disposable implementation can answer a specific logic, state, or UI design question before committing to a production design.

## Invocation

Use `/prototype [design question]` in Claude Code or `$prototype [design question]` in ChatGPT. Name the decision the prototype should inform, or let the agent infer it from the surrounding task.

## What happens

The agent frames one question and chooses a logic or UI prototype. It builds the smallest runnable artifact that makes the answer visible, runs the decisive happy path and relevant edge cases, then puts it in front of you for feedback. The handoff gives the exact open or run instruction, what was observed, the limitations, and the decision the evidence supports.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. The agent follows user or project prototype instructions. Otherwise, it checks for uncommitted work and pauses for you to clean the working tree if needed. With a clean tree, it creates and switches to a new `proto/<prototype-name>` branch, choosing a descriptive name, then develops, commits, and pushes the prototype there.

## Example

`/prototype Would this state model handle interrupted uploads?` asks for a runnable logic experiment and a conclusion tied to that case.

## Pi usage

Use `/skill:prototype [design question]`. Keep the shared clean-tree/throwaway-branch workflow and its interactive-only delegation rule. Available browser tooling determines UI verification depth; report missing capabilities.
