---
name: prototype
description: Build a disposable prototype to answer a design question. Use when the user asks for a prototype, draft or preview.
argument-hint: "[design question]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Prototype

A prototype is **throwaway code that answers a design question**. The question
decides the shape and the stopping point.

## Frame the question

State the question in one sentence and name the decision its answer will inform.
Then choose the prototype shape:

- **Does this logic or state model feel right?** Read [LOGIC.md](LOGIC.md).
- **What should this interface look and feel like?** Read [UI.md](UI.md).

If the question is ambiguous, ask the user when they are available. Otherwise,
infer the shape from the surrounding work and show the assumption in the
prototype.

## Set up the prototype

Follow the user's or project's prototype instructions (check `AGENTS.md`,
`CLAUDE.md`, and contributor docs). Otherwise, use this branch workflow:

Check `git status --short` before starting. If there are staged, unstaged, or
untracked changes, stop and ask the user to make the working tree clean before
you proceed. Once it is clean, choose a descriptive prototype name and create
and switch to a new `proto/<prototype-name>` branch. Develop the prototype on
that branch, make sur your prototype edits are not gitignored. Report any inconsistency/contradiction between this rule, the project rules and architecture and the user's request.

Inspect the repository for domain language, behavior, dimensions, and visual
conventions.

## Prototype loop

1. Write the question and material assumptions into the prototype.
2. Build the smallest artifact that makes the answer observable.
3. Run the decisive happy path and edge cases; fix only defects that obscure
   the answer.
4. Put the runnable prototype in front of the user and incorporate feedback
   while it sharpens the same question.
5. Stop when the prototype supplies enough evidence for the named decision.

Keep state in memory and use representative fixtures. Make startup obvious: one
file to open or one command to run. Spend effort on the behavior being judged,
not tests, production hardening, reusable abstractions, or unrelated cleanup.

## Handoff

Lead with the answer. Give the prototype's location and exact open/run instruction,
then state the evidence, limitations, and decision it supports. Keep claims
within what the prototype actually exercised.
