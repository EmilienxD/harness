---
name: grill-me-in-cloud
description: Developer-invoked only. Agents must not invoke this skill on their own. Stress-test a plan through branching interview rounds on a persistent hosted board.
argument-hint: "[plan or design]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Interview the developer relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, give 1–4 options, and provide your recommended answer. Prefer giving your recommendation as **the first option** (A) for readability. Then publish the round to the hosted board and wait for the developer's answers before the next round.

Each round the developer answers reshapes the tree: settled decisions push the frontier outward and unblock questions that **depend** on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the developer's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), explore to find it; don't ask the developer for anything you could look up yourself in the codebase. When working with sub-agents, don't block on them: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent(s) to report; ask the rest of the frontier now. The _decisions_ are the developer's: present each to them and wait.

Prioritize questioning high-impact decisions (e.g., UI/UX changes, failure behavior, scope boundaries, interaction with existing rules, architecture changes, dependency changes, migrations, security concerns) over low-impact decisions (e.g., creating a class, creating new tests, updating an endpoint).

If a question cannot be answered solely from the code or from judgment, you may consider a web search to find real-world examples, open-source code to reuse, benchmarks, or prototyping before assuming your recommendation is correct. If so, propose your ideas to the developer before proceeding (e.g., "This API doesn't provide enough documentation; we should consider prototyping it before assuming it's the right decision.").

Every question requires an explicit answer from the developer. Silence, omission, an ambiguous response, or answering other questions does not approve your recommendation. Keep every unanswered question open and present it again in a later round; settle only the questions the developer actually answered.

The session is done when the frontier is empty: every branch of the design tree has been visited, and nothing is left silently assumed. Do not act on it until the developer confirms you have reached a shared understanding. Simply tell the developer that you have reached a shared understanding, summarize the core solution decided upon to solve the initial problem in 1–3 sentences, and state that you are ready to proceed to the next steps.

## Publishing a round

The runtime supplies an inbox file, an assets directory, and an assets URL prefix outside the project, reserved for this session. Write supporting assets first, then write the complete round JSON directly to the supplied inbox file; that successful tool call triggers publication. Use the updated locations returned with each publication result or validation error for the next write.

After publication succeeds, reply only `Round <round-number> with <questions-count> questions available at <url>`. End your turn and wait for answers.

On a validation rejection, fix the reported problem and write the complete round to the updated inbox file. On a setup or publication failure such as no inbox file supplied, report the error without diagnosing it and stop.

Nothing persists between rounds or between questions: give every question all the context, styles, scripts, and media it needs. The developer answers from the board alone, with no access to the codebase: a file path is only a label, so when a decision depends on specific code, quote those lines as a code block captioned with the path and line range, inside `<details>` when long.

The following JSON + HTML inbox system is strictly reserved for grilling questions; once a shared understanding has been reached, you must forget this system and continue communicating through normal text messages.

## Round JSON

```json
{
  "questions": [{
    "id": "Q1",
    "question": "When should a round become visible?",
    "explanation_html": "<p>Rounds may reference images, so the order of writes matters.</p>",
    "recommendation": "A",
    "options": [
      {"letter": "A", "label": "Publish on write", "detail": "Write assets first and the round last. No separate publication command."},
      {"letter": "B", "label": "Publish explicitly", "detail": "Invoke publication after drafting. One more tool call, but drafting stays private."}
    ],
    "init_js": "root.querySelector('select').addEventListener('change', (e) => { root.querySelector('output').textContent = e.target.value; });"
  }]
}
```

- `init_js` is optional, and the runtime numbers the round.
- IDs are unique `Q1`, `Q2`, …; an unanswered question keeps its ID in later rounds.
- `question` is the plain-text heading. `explanation_html` gives the minimum context needed to choose: a short lead and, when useful, a compact visual of the consequences or uncertainty.
- Options are lettered consecutively from A. Give each `label` a short, descriptive title that identifies the choice on its own. Each plain-text `detail` gives the behavior and tradeoff in one concise sentence; the recommended option's `detail` carries your rationale.
- The board adds a "None of these" choice and a free-text note to every question, so skip catch-all options.

## Explanation HTML

Write semantic HTML; the board styles paragraphs, headings, tables, figures, code, and `<details>`. Custom styling uses the board's variables (`--paper`, `--surface`, `--ink`, `--ink-2`, `--ink-soft`, `--accent`, `--accent-soft`, `--font-head`, `--font-body`), never another theme or CDN design system; only a preview of a product's UI reproduces that product's real look. Helpers: `.grid` (two columns, stacked when narrow), `.panel` (inset card), and `.note` (accent callout). Label code blocks as `<pre><code class="language-python">`; guessing is unreliable, and `language-text` keeps diagrams and output plain.

Prefer visuals over long prose text.

Every visual explains the decision rather than decorating it:

- **Comparisons** align the same criteria and show costs as plainly as benefits.

- **Tables** hold rows that share fields; say what the table shows before it. The board scrolls every table horizontally when it is too wide, so never force cell widths or wrapping.

- **Static diagrams** use inline SVG (`viewBox`, `width="100%"`, `<title>`) for illustrations that need explicit visual composition, with page variables, short labels, and prose outside. SVGs loaded through `<img>` cannot read page variables, so give them literal fallbacks such as `var(--surface, #fbfaf6)`.

- **Dynamic & editable diagrams** use the Mermaid figure; give meaningful node groups explicit Mermaid `style` or `classDef` fill, stroke, and text colors using literal hex values, since Mermaid theme colors do not reliably survive Excalidraw conversion:

```html
<figure data-grill-diagram="publication-flow">
  <pre class="mermaid">flowchart LR
    A[Write assets] --&gt; B[Publish round]
    B --&gt; C[Developer reviews]</pre>
  <figcaption>Assets are ready before the developer sees the round.</figcaption>
</figure>
```

Give each figure a stable, descriptive `data-grill-diagram` ID unique within its question: start with a letter, then use letters, digits, `_` or `-`, up to 64 characters. Keep the same ID when moving a diagram or retaining its meaning in a later round. Different questions may reuse an ID.

Each figure has one direct `<pre class="mermaid">` with nonempty Mermaid source and one direct, nonempty `<figcaption>` explaining what the diagram helps decide. HTML-escape source characters (`&amp;`, `&lt;`, `&gt;`); keep source as text inside the `<pre>`. Supply source and caption without initialization JavaScript or external Mermaid scripts; the system auto converts it into an Excalidraw canva.

To review diagram changes, you will receive either an image path directly or a remote image ID (depending on user settings). No path or ID means no changes. Download each remote image ID with `<skill-directory>/scripts/download_grill_image.py <id>`. If a download fails, report the error. Otherwise the script will return the path. Then, read each image from its local path.

- **Images**, such as real project screenshots for UI decisions, use the assets URL prefix and useful alt text. Declare every local media URL in an HTML attribute: `src`, `srcset`, `poster`, dropdown `value`, link `href`, or a `data-*` attribute. For interactive previews, have `init_js` read those attributes from `root`; publication uploads their files and replaces the attribute URLs. Keep each image within 6 MiB and each round within 30 local media references / 50 MiB.

- **Videos** use the same assets directory and URL prefix as images: `<video src="assets/round-001/demo.mp4" controls playsinline preload="none" aria-label="Checkout interaction preview"></video>`. Use `<figcaption>` for optional caption. Optional `poster` images and `<source src>` references use the same asset workflow. Keep each source and prepared video within 20 MiB. Skip format preparation; the system will convert with ffmpeg if needed.

- **Demos** use native controls wired in `init_js`, which runs once after mounting with `root` as the question's explanation element; `<script>` tags never run. Query within `root`, prefix IDs with the question ID (`Q1-preview`), keep the explanation clear without interaction, and leave answering to the board's form.

- **Custom CSS** is scoped under `#explanation-Q1`; custom grids use `minmax(0, 1fr)` and `min-width: 0`. Check narrow widths and that SVG labels fit their shapes.
