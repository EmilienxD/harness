---
name: next-decision
description: Resolve a plan's open decisions one at a time by presenting the most important unresolved choice, four viable options, and a recommendation. Use when the user asks for the "next decision" or "one decision at a time," or wants to work through several unresolved choices sequentially. Forward-looking; use decisions to review choices already made.
argument-hint: "[plan or topic]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Work through open decisions one at a time.

For each round:

1. Identify the most important unresolved decision whose prerequisites are settled.
2. Present the four strongest distinct choices.
3. Recommend one choice with a concise reason.
4. Ask the user which they prefer, then stop and wait.

Keep the round concise. Resolve facts from available context or tools instead of presenting them as user decisions.

After the user decides, record the answer in the conversation and update the existing plan document when the task includes one. Then repeat with the next most important open decision. When no open decisions remain, say so.
