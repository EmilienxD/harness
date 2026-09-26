---
name: prototype
description: Build a disposable prototype in a dedicated prototype folder to answer a design question. Use when implementation evidence is needed before choosing a design.
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

## Choose the prototype workspace

Put the prototype in a **prototype workspace**: a dedicated folder inside the
current repository. Use a location supplied by the user; otherwise follow the
project's conventions for prototypes or scratch work (check `AGENTS.md`,
`CLAUDE.md`, contributor docs, and existing folders). If the project specifies
nothing, create a new top-level folder whose name clearly marks it as
prototype work, such as `prototypes/` or `scratch/`, choosing a name that does
not already exist. Put each prototype in its own `<prototype-name>/` subfolder.

When you create the workspace folder, add a `.gitignore` inside it containing
`*` so its contents stay out of version control.

Inspect the repository for domain language, behavior, dimensions, and visual
conventions. Keep every prototype artifact and dependency in the prototype
workspace, leaving the repository's source files unchanged.

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

Lead with the answer. Give the prototype's path and exact open/run instruction,
then state the evidence, limitations, and decision it supports. Keep claims
within what the prototype actually exercised.
