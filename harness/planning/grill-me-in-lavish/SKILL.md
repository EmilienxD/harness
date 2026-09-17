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

Invoke every CLI command as `npx -y lavish-axi ...`, including follow-up commands whose output starts with `lavish-axi`. Create the HTML under `.lavish/` unless the user specifies another location, open it with Lavish, and poll for submitted answers. Do not duplicate the round as a prose questionnaire in chat.

Build each round from [`assets/board-template.html`](assets/board-template.html). Copy the template to the artifact location and replace only its `__GRILL_ME_DATA__` marker with valid JSON matching the schema documented beside that marker. Keep the template's structure, styles, and interaction code intact; update the payload rather than improvising a new page.

Format each round in the artifact like the original questionnaire, enhanced visually where that makes the decision easier to understand:

- Give every question a stable visible number such as **Q1**, a title, its full question body, 1–4 options labeled A onward, and a short `Recommended: A` explanation.
- Use comparisons, diagrams, screenshots, or images when they materially improve the explanation or recommendation. Use real project visuals when available; place local assets beside the HTML and use relative paths in the question's optional `image` payload.
- Make each complete option a native clickable `<label>` containing a radio input. Put the recommended answer in A and mark A `checked` when the artifact opens, while making clear that a preselection is not an answer until submitted.
- Give every question its own form and **Queue this answer** button. Queueing records that question locally in Lavish but does not send feedback to the agent. Use a stable per-round, per-question `queueKey` so re-queueing replaces the earlier unsent version.
- Always provide the template's freeform answer field and **Write my own answer** control. The user may supplement a listed option or clear the preselection and answer entirely outside the proposed choices.
- Provide one board-level **Submit round** button. It calls `window.lavish.sendQueuedPrompts()` once to send all and only the answers the user queued in that round. An unqueued question remains open, and an edited queued answer must be re-queued before the round can be submitted.
- Queue concise natural-language answers without attaching a `data` object or serializing responses as JSON into the conversation.
- Show queued state separately from local selected state. Radio and text changes update only local state.
- Keep the native controls keyboard-accessible, readable on mobile, and free of horizontal overflow.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that **depend** on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), explore to find it; don't ask the user for anything you could look up yourself in the codebase. When working with sub-agents, don't block on them: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent(s) to report; ask the rest of the frontier now. The _decisions_ are the user's: present each to them and wait.

Prioritize questioning high-impact decisions (e.g., UI/UX changes, failure behavior, scope boundaries, interaction with existing rules, architecture changes, dependency changes, migrations, security concerns) over low-impact decisions (e.g., creating a class, creating new tests, updating an endpoint).

If a question cannot be answered solely from the code or from judgment, you may consider a web search to find real-world examples, open-source code to reuse, benchmarks, or prototyping before assuming your recommendation is correct. If so, propose your ideas to the user before proceeding (e.g., "This API doesn't provide enough documentation; we should consider prototyping it before assuming it's the right decision.").

Every question requires an explicit queued answer included in a submitted round. A preselected recommendation, silence, omission, an ambiguous response, or answering other questions does not approve the recommendation. Keep polling the current artifact while the user queues answers; do not start another agent round for each queued question. Only after **Submit round** sends the batch should you settle its answered questions, keep every unqueued question open, recompute the frontier, and replace the HTML with the next round's questions.

The session is done when the frontier is empty: every branch of the design tree has been visited, and nothing is left silently assumed. Do not act on it until the user confirms you have reached a shared understanding. Simply tell the user that you have reached a shared understanding, summarize the core solution decided upon to solve the initial problem in 1–3 sentences, and state that you are ready to proceed to the next steps.
