---
name: grill-me-in-lavish
description: Stress-test a plan through branching interview rounds in an interactive Lavish board.
argument-hint: "[plan or design]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map the plan as a **design tree**: each decision branches into the decisions that depend on it.

## Interview workflow

Use the exact fresh inbox path supplied by the hook. If no path is supplied, report that the runtime hooks are missing or inactive.

Work in **rounds**. The **frontier** is every decision whose prerequisites are settled. Ask the whole frontier together, then wait for submitted answers. A question depending on another unanswered question belongs to a later round.

Finding facts is your job: inspect the codebase and environment before asking for decisions. Prioritize high-impact choices about behavior, UX, scope, architecture, failure handling, dependencies, and migrations. The decisions belong to the user.

For each round:

1. Compose numbered questions with stable IDs. Ask the actual question, then explain why it matters: relevant context, consequences, and uncertainty. Use several concise sentences or a compact visual explanation, scaled to the decision's difficulty.
2. Provide normally four proposals, A–D; use fewer when further proposals would be artificial. Explain every proposal's behavior and tradeoff. Put the recommendation first as A when practical; its rationale belongs in that proposal's explanation.
3. Write any supporting assets first in the supplied assets directory. Create the complete round JSON directly at the exact fresh path supplied by the hook. The runtime owns this directory outside the project, creates its parents, and reserves the filename. You are its sole inbox writer; create the file directly without listing the directory or reading a template. Write the round file last: a successful write publishes it automatically.
4. The write hook renders the board, opens it through Lavish, and waits for submitted feedback in the same tool call. Continue from the returned answers. If the write fails or is interrupted, report the issue in chat. Work through the supplied inbox; hooks own rendering, opening, and polling. Keep the questionnaire in the artifact.

When feedback arrives, settle only explicit answers in the submitted batch, retain unanswered questions, and recompute the frontier. Recommendations begin unselected. Local selection and queueing are not submission; silence and omitted questions approve nothing. Freeform answers may replace or supplement a proposal. Fatal artifact errors require a repaired round rather than settling decisions. Validation errors supply a fresh path for the corrected complete payload.

## Round contract

Create UTF-8 JSON shaped like this. The runtime assigns the round number; round titles and subtitles are unnecessary.

```json
{
  "questions": [{
    "id": "Q1",
    "question": "When should a round become visible?",
    "explanation_html": "<p>Publication makes the questions available for review. A round may reference images or interactive examples, so the order of writes matters.</p><p>We need to choose whether writing the complete round commits it immediately or requires a separate publication step.</p>",
    "recommendation": "A",
    "options": [
      {"letter": "A", "label": "Publish on write", "detail": "Write assets first and the round last. This avoids a separate publication command."},
      {"letter": "B", "label": "Publish explicitly", "detail": "Prepare the content, then invoke publication. This adds a tool call but separates drafting from publication."}
    ]
  }]
}
```

IDs must be unique Q1, Q2, etc. Keep an unanswered decision's ID across rounds. Options use consecutive letters A onward, with 1–4 explained proposals and a recommendation naming one available letter. Question, option label, and detail are plain text; `explanation_html` is HTML.

For interactive explanations, add optional `init_js` to that question. It executes once after mounting, with `root` referring to that question's explanation element:

```json
"init_js": "const select = root.querySelector('select'); const preview = root.querySelector('output'); select.addEventListener('change', () => { preview.textContent = select.value; });"
```

Put script logic in `init_js`, since script tags inserted as HTML do not initialize. Scope DOM queries to `root`, use distinct IDs such as `Q1-preview`, and keep demonstration controls local. The board owns answer forms, queueing, and submission. For larger examples, `init_js` may load a script from the supplied empty assets directory. Use the hook-supplied relative URL prefix for supporting files, including images with useful alt text.

## HTML and visual style

The board supplies its style: warm paper (`--paper`), cream cards (`--surface`), charcoal text (`--ink`, `--ink-2`), muted secondary text (`--ink-soft`), and restrained navy emphasis (`--accent`, `--accent-soft`). Headings use `--font-head` (Space Grotesk); body text uses `--font-body` (DM Sans). Match these variables instead of introducing another page theme or a CDN design system. Product UI previews should reproduce the subject product's actual appearance inside this explanation.

Use semantic HTML. The explanation automatically styles paragraphs, headings, figures, captions, tables, code blocks, and disclosures. Available helpers:

- `.grid`: two equal columns, stacked on narrow screens; `.panel`: a lightly bordered inset card.
- `.note`: a restrained accent callout; `.table-wrap`: a horizontally contained table wrapper.
- `<details><summary>…</summary>…</details>`: optional supporting detail, with the essential rationale visible.

Use these focused Lavish authoring principles:

- **Comparison:** align the same criteria, show concrete behavior, and make costs as visible as benefits. Keep the recommendation in its proposal.
- **Table:** use a table when rows share fields. State what the comparison demonstrates before the table; use semantic headers and `.table-wrap` for wide content.
- **Diagram:** explain one concept at a time with responsive inline SVG (`viewBox`, width 100%). Give meaningful elements stable IDs and `<title>` descriptions. Use page color variables and short labels, with explanatory prose outside the SVG. External SVGs loaded through `<img>` cannot inherit page CSS variables; define their colors/fonts locally or use literal fallbacks such as `var(--surface, #fbfaf6)`.
- **Interaction:** native selectors, sliders, and buttons can demonstrate behavior, but changes remain local until the board's explicit answer submission. Label controls and keep explanations understandable without interaction.
- **Layout:** contain media and code; use `minmax(0, 1fr)` and `min-width: 0` for custom grids. Scope additional CSS beneath `#explanation-Q1` (or the relevant ID). The board disables explanation animations for reduced-motion preferences.

Use real project screenshots when they clarify a UI decision. Tables, SVG, images, or animations should explain the decision, rather than decorate it. For unfamiliar advanced visuals, consult only the matching `npx -y lavish-axi playbook <id>`; the board already provides the page design and input lifecycle. Verify custom visuals at narrow widths; inspect SVG interiors because Lavish's layout audit does not check them.

When the frontier is empty, summarize the agreed solution in chat. If the user cancels or changes tasks, continue in chat. The board stays open for reference; another round file starts another wait.

Chat interrupts waiting. To revise an unsubmitted round, use the fresh path supplied by the hook. The revision opens a separate review; tell the user that unsent answers must be queued again. Ordinary submitted rounds reload the existing board.
