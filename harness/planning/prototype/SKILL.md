---
name: prototype
description: Build a throwaway prototype outside the codebase to answer a design question.
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

## Work outside the codebase

Put the prototype in a **prototype workspace**: a separate folder outside the
repository. Use a location supplied by the user; otherwise create a sibling
folder named `<repository>-prototypes/<prototype-name>`.

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
