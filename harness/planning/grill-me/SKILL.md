---
name: grill-me
description: Developer-invoked only. Agents must not invoke this skill on their own. Interview the developer relentlessly about a plan or design until reaching a shared understanding, resolving each branch of the decision tree. Use when the developer wants to stress-test a plan, get grilled on their design, or mentions "grill me".
argument-hint: "[plan or design]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Interview the developer relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, give 1–4 options, and provide your recommended answer. Prefer giving your recommendation as **the first option** (A) for readability. Then wait for the developer's answers before the next round.

Format a round like this example:

```
**Q1** - **<question title>**: <question body, might be multiple paragraphs>

A. <First option>

B. <Second option>

C. <Third option>

D. <Fourth option>

Recommended: **A**. <your recommended answer explained, kept short and concise>

---

**Q2** - **<question title>**: <question body, might be multiple paragraphs>

A. <First option>

B. <Second option>

Recommended: **A**. <your recommended answer explained, kept short and concise>

...
```

Each round the developer answers reshapes the tree: settled decisions push the frontier outward and unblock questions that **depend** on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the developer's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), explore to find it; don't ask the developer for anything you could look up yourself in the codebase. When working with sub-agents, don't block on them: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent(s) to report; ask the rest of the frontier now. The _decisions_ are the developer's: present each to them and wait.

Prioritize questioning high-impact decisions (e.g., UI/UX changes, failure behavior, scope boundaries, interaction with existing rules, architecture changes, dependency changes, migrations, security concerns) over low-impact decisions (e.g., creating a class, creating new tests, updating an endpoint).

If a question cannot be answered solely from the code or from judgment, you may consider a web search to find real-world examples, open-source code to reuse, benchmarks, or prototyping before assuming your recommendation is correct. If so, propose your ideas to the developer before proceeding (e.g., "This API doesn't provide enough documentation; we should consider prototyping it before assuming it's the right decision.").

Every question requires an explicit answer from the developer. Silence, omission, an ambiguous response, or answering other questions does not approve your recommendation. Keep every unanswered question open and present it again in a later round; settle only the questions the developer actually answered.

The session is done when the frontier is empty: every branch of the design tree has been visited, and nothing is left silently assumed. Do not act on it until the developer confirms you have reached a shared understanding. Simply tell the developer that you have reached a shared understanding, summarize the core solution decided upon to solve the initial problem in 1–3 sentences, and state that you are ready to proceed to the next steps.
