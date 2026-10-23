# Next decision

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install next-decision`; see [installation and scope](../../getting-started.md).

## Use it

Invoke `/next-decision` in Claude Code or `$next-decision` in ChatGPT with a plan or topic, for example `$next-decision API migration plan`.

## What happens

Each round selects the most important open choice whose prerequisites are settled, presents four viable options, recommends one, and waits for your answer. After you choose, the agent records the decision, updates an existing plan document when the task includes one, and continues to the next choice. It stops when none remain. Use `decisions` to review uncertain choices already made.

## Practical note

Point the agent to an existing plan file when you want answers recorded there. You can accept the recommendation or choose another option; the skill then moves to the next ready decision. Facts the agent can establish from available context are resolved before asking you to decide.

## Pi usage

Use `/skill:next-decision [plan]`. The shared workflow presents recommendations and waits for the user to choose before continuing the decision sequence.
