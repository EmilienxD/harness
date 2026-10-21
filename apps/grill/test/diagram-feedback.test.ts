import assert from "node:assert/strict";
import test from "node:test";
import { diagramChanged, meaningfulScene, summarizeDiagram } from "../src/lib/diagram-feedback.ts";
import { copyScene, type DiagramScene } from "../src/lib/diagram-scene.ts";

const fixture = () =>
  ({
    elements: [
      {
        id: "a",
        type: "rectangle",
        x: 1,
        y: 2,
        width: 100,
        height: 50,
        angle: 0,
        strokeColor: "#000",
        boundElements: [{ id: "text", type: "text" }],
        version: 1,
        versionNonce: 42,
        updated: 0,
        index: "a0",
        isDeleted: false,
      },
      {
        id: "text",
        type: "text",
        containerId: "a",
        text: "Start",
        originalText: "Start",
        x: 5,
        y: 6,
        width: 50,
        height: 20,
        isDeleted: false,
      },
      { id: "b", type: "rectangle", x: 201, y: 2, width: 100, height: 50, isDeleted: false },
      {
        id: "arrow",
        type: "arrow",
        x: 101,
        y: 20,
        width: 100,
        height: 0,
        points: [
          [0, 0],
          [100, 0],
        ],
        startBinding: { elementId: "a", focus: 0, gap: 0 },
        endBinding: { elementId: "b", focus: 0, gap: 0 },
        isDeleted: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  }) as unknown as DiagramScene;

test("viewport, selections, bookkeeping and tombstones are unchanged; undo restores baseline", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  Object.assign(next.appState, {
    scrollX: 200,
    scrollY: 500,
    zoom: { value: 2 },
    selectedElementIds: { a: true },
    gridSize: 20,
  });
  Object.assign(next.elements[0]!, { version: 20, versionNonce: 98, updated: 1234, index: "b0" });
  next.elements = [...next.elements, { ...next.elements[0]!, id: "deleted", isDeleted: true }];
  assert.equal(diagramChanged(baseline, next), false);
  assert.equal(summarizeDiagram(baseline, next), "No changes were made to the diagram.");
  Object.assign(next.elements[0]!, { x: 400 });
  assert.equal(diagramChanged(baseline, next), true);
  Object.assign(next.elements[0]!, { x: 1 });
  assert.equal(diagramChanged(baseline, next), false);
});

for (const [name, patch] of Object.entries({
  movement: { x: 20 },
  resize: { width: 300 },
  rotation: { angle: 1 },
  appearance: { strokeColor: "red" },
  grouping: { groupIds: ["g"] },
}))
  test(`meaningful ${name} survives canonical comparison`, () => {
    const baseline = fixture();
    const next = copyScene(baseline);
    Object.assign(next.elements[0]!, patch);
    assert.notEqual(meaningfulScene(baseline), meaningfulScene(next));
    assert.notEqual(summarizeDiagram(baseline, next), "No changes were made to the diagram.");
  });

test("labels, point reshaping and endpoint bindings have recognizable summaries", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  Object.assign(next.elements[1]!, { text: "Revised", originalText: "Revised" });
  Object.assign(next.elements[3]!, {
    endBinding: { elementId: "a", gap: 0, focus: 0 },
    points: [
      [0, 0],
      [40, 20],
    ],
  });
  const summary = summarizeDiagram(baseline, next);
  assert.match(summary, /Changed label "Start" to "Revised"/u);
  assert.match(summary, /Reconnected arrow/u);
  assert.match(summary, /rectangle "Start"/u);
  assert.match(summary, /Reshaped arrow/u);
  const movedText = copyScene(baseline);
  Object.assign(movedText.elements[1]!, { x: 9 });
  assert.doesNotMatch(summarizeDiagram(baseline, movedText), /Changed label/u);
});

test("order, background and referenced image bytes matter; file retrieval metadata does not", () => {
  const baseline = fixture();
  const reordered = copyScene(baseline);
  reordered.elements = [...reordered.elements].reverse();
  assert.match(summarizeDiagram(baseline, reordered), /drawing order/u);
  const background = copyScene(baseline);
  background.appState.viewBackgroundColor = "red";
  assert.match(summarizeDiagram(baseline, background), /canvas background/u);
  const image = copyScene(baseline);
  image.elements = [
    { ...image.elements[0]!, type: "image", fileId: "f" } as unknown as DiagramScene["elements"][number],
  ];
  image.files = {
    f: { id: "f", dataURL: "data:image/png;base64,AAAA", mimeType: "image/png", created: 1 },
  } as unknown as DiagramScene["files"];
  const retrieved = copyScene(image);
  Object.assign(retrieved.files["f"]!, { created: 20, lastRetrieved: 99 });
  assert.equal(diagramChanged(image, retrieved), false);
  Object.assign(retrieved.files["f"]!, { dataURL: "data:image/png;base64,BBBB" });
  assert.match(summarizeDiagram(image, retrieved), /image content/u);
});

test("removal retains baseline labels and output is deterministic and bounded", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  next.elements = [];
  assert.match(summarizeDiagram(baseline, next), /Removed rectangle "Start"/u);
  const many = copyScene(baseline);
  many.elements = Array.from({ length: 200 }, (_, index) => ({ ...baseline.elements[0]!, id: `new${index}` }));
  const summary = summarizeDiagram(baseline, many);
  assert.equal(summary, summarizeDiagram(baseline, many));
  assert.ok(summary.split("\n").length <= 40);
  assert.ok(summary.split("\n").every((line) => line.length <= 200));
});

test("SVG serialization on editor load is unchanged, but edits to image content are meaningful", () => {
  const baseline = fixture();
  baseline.elements = [
    { ...baseline.elements[0]!, type: "image", fileId: "svg" } as unknown as DiagramScene["elements"][number],
  ];
  const url = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  baseline.files = {
    svg: {
      id: "svg",
      mimeType: "image/svg+xml",
      created: 1,
      dataURL: url('<svg width="100" xmlns="http://www.w3.org/2000/svg" height="100"><path d="M 0 0 L 10 10"/></svg>'),
    },
  } as unknown as DiagramScene["files"];
  const loaded = copyScene(baseline);
  Object.assign(loaded.files["svg"]!, {
    dataURL: url('<svg xmlns="http://www.w3.org/2000/svg" height="100" width="100"><path d="M 0 0 L 10 10" /></svg>'),
  });
  assert.equal(diagramChanged(baseline, loaded), false);
  assert.equal(summarizeDiagram(baseline, loaded), "No changes were made to the diagram.");
  Object.assign(loaded.files["svg"]!, {
    dataURL: url('<svg xmlns="http://www.w3.org/2000/svg" height="100" width="100"><path d="M 0 0 L 20 20" /></svg>'),
  });
  assert.equal(diagramChanged(baseline, loaded), true);
  assert.match(summarizeDiagram(baseline, loaded), /image content/u);
  Object.assign(baseline.files["svg"]!, { dataURL: url("not an SVG") });
  Object.assign(loaded.files["svg"]!, { dataURL: url("different invalid SVG") });
  assert.equal(diagramChanged(baseline, loaded), true);
});
