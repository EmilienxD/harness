import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAuthoredDiagrams } from "../src/lib/grill-diagrams.ts";
import { roundPayloadSchema } from "../src/lib/grill-contract.ts";

const figure = (id = "publish", source = "flowchart LR\n A --&gt; B", caption = "Write before publication") =>
  `<figure data-grill-diagram="${id}"><pre class="mermaid">${source}</pre><figcaption>${caption}</figcaption></figure>`;
const question = (html: string, id = "Q1") => ({
  id,
  question: "When to publish?",
  explanation_html: html,
  recommendation: "A",
  options: [{ letter: "A", label: "After writing", detail: "Avoid incomplete content" }],
});

test("extracts explicit identities, decoded sources, multiline labels and formatted captions in order", () => {
  assert.deepEqual(
    extractAuthoredDiagrams(
      `<p>Context</p>${figure("flow", 'flowchart LR\r\n A["Read &amp; write&lt;br/&gt;assets"] --&gt; B', "<strong>Publish</strong> last")}${figure("other")}`,
    ),
    [
      { id: "flow", source: 'flowchart LR\n A["Read & write<br/>assets"] --> B', caption: "Publish last" },
      { id: "other", source: "flowchart LR\n A --> B", caption: "Write before publication" },
    ],
  );
});

test("moving figures preserves their identities and existing HTML and initialization remain intact", () => {
  const html = `<p>Context</p>${figure("second")}${figure("first")}<svg><title>Illustration</title></svg>`;
  const authored = { ...question(html), init_js: "root.dataset.ready = 'yes'" };
  assert.deepEqual(roundPayloadSchema.parse({ questions: [authored] }).questions[0], authored);
  assert.deepEqual(
    extractAuthoredDiagrams(html).map((diagram) => diagram.id),
    ["second", "first"],
  );
  assert.equal(
    roundPayloadSchema.safeParse({ questions: [question(figure()), question(figure(), "Q2")] }).success,
    true,
  );
});

test("ordinary HTML, code samples and scripts are not diagrams", () => {
  assert.deepEqual(
    extractAuthoredDiagrams(
      '<pre class="mermaid">old noneditable content</pre><code>&lt;figure data-grill-diagram="example"&gt;</code><script>const example = `<figure data-grill-diagram="script">`</script>',
    ),
    [],
  );
});

test("publication rejects ambiguous identities and incomplete diagrams locally", () => {
  for (const html of [
    figure() + figure(),
    figure("1bad"),
    figure("bad id"),
    figure("x", " "),
    figure("x", "graph TD", " "),
    figure("x", "A<br>B"),
    '<div data-grill-diagram="x"></div>',
    `<figure data-grill-diagram="outer">${figure("inner")}</figure>`,
  ]) {
    assert.equal(roundPayloadSchema.safeParse({ questions: [question(html)] }).success, false, html);
  }
});
