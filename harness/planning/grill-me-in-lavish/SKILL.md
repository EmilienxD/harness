---
name: grill-me-in-lavish
description: Stress-test a plan or design through a branching interview presented as interactive Lavish HTML, with visual explanations, clickable choices, and preselected recommendations. Use when the user explicitly asks to be grilled in Lavish.
argument-hint: "[plan or design]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, give 1–4 options, and provide your recommended answer. Prefer giving your recommendation as **the first option** (A) for readability. Then wait for the user's answers before the next round.

Present every round as an interactive Lavish HTML artifact. Before writing HTML, get the current source of truth from the CLI:

- `npx -y lavish-axi --help` for commands and the review loop
- `npx -y lavish-axi design` for current design guidance
- `npx -y lavish-axi playbook input` for interactive controls
- `npx -y lavish-axi playbook <id>` for every other playbook that matches the round's visual content

Invoke every CLI command as `npx -y lavish-axi ...`, including follow-up commands whose output starts with `lavish-axi`. Create the HTML under `.lavish/` unless the user specifies another location, open it with Lavish, and poll for the submitted answers. Do not duplicate the round as a prose questionnaire in chat.

Format each round in the artifact like the original questionnaire, enhanced visually where that makes the decision easier to understand:

- Give every question a stable visible number such as **Q1**, a title, its full question body, 1–4 options labeled A onward, and a short `Recommended: A` explanation.
- Use comparisons, diagrams, screenshots, or images when they materially improve the explanation or recommendation. Use real project visuals when available; place local assets beside the HTML and use relative paths.
- Make each complete option a native clickable `<label>` containing a radio input. Put the recommended answer in A and mark A `checked` when the artifact opens.
- Treat the round as one tracked form with `data-lavish-question`. Provide one prominent **Submit answers** button that reads every final selection, calls `window.lavish.queuePrompt()` exactly once with a bounded `data.answers` array containing each question number, selected letter, and option label, then calls `window.lavish.sendQueuedPrompts()`.
- Use a stable `queueKey` for the round so resubmission replaces an unsent predecessor. Show submitted state separately from local selected state. Radio changes update only local state.
- Keep the native controls keyboard-accessible, readable on mobile, and free of horizontal overflow. Include a custom-answer control when the listed choices cannot express a reasonable answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that **depend** on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), explore to find it; don't ask the user for anything you could look up yourself in the codebase. When working with sub-agents, don't block on them: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent(s) to report; ask the rest of the frontier now. The _decisions_ are the user's: present each to them and wait.

Prioritize questioning high-impact decisions (e.g., UI/UX changes, failure behavior, scope boundaries, interaction with existing rules, architecture changes, dependency changes, migrations, security concerns) over low-impact decisions (e.g., creating a class, creating new tests, updating an endpoint).

If a question cannot be answered solely from the code or from judgment, you may consider a web search to find real-world examples, open-source code to reuse, benchmarks, or prototyping before assuming your recommendation is correct. If so, propose your ideas to the user before proceeding (e.g., "This API doesn't provide enough documentation; we should consider prototyping it before assuming it's the right decision.").

Assume the user has approved your recommendation if they do not provide their own choice or a different answer to a question. Flag it in 1 short sentence at the top of your next round message.

The session is done when the frontier is empty: every branch of the design tree has been visited, and nothing is left silently assumed. Do not act on it until the user confirms you have reached a shared understanding. Simply tell the user that you have reached a shared understanding, summarize the core solution decided upon to solve the initial problem in 1–3 sentences, and state that you are ready to proceed to the next steps.
