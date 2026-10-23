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
  assert.equal(summarizeDiagram(baseline, next), "");
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
    assert.notEqual(summarizeDiagram(baseline, next), "");
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
  assert.equal(summary, "Updated labels, connections and layout.");
  const movedText = copyScene(baseline);
  Object.assign(movedText.elements[1]!, { x: 9 });
  assert.doesNotMatch(summarizeDiagram(baseline, movedText), /labels/u);
});

test("order, background and referenced image bytes matter; file retrieval metadata does not", () => {
  const baseline = fixture();
  const reordered = copyScene(baseline);
  reordered.elements = [...reordered.elements].reverse();
  assert.match(summarizeDiagram(baseline, reordered), /layout/u);
  const background = copyScene(baseline);
  background.appState.viewBackgroundColor = "red";
  assert.match(summarizeDiagram(baseline, background), /styling/u);
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
  assert.match(summarizeDiagram(image, retrieved), /images/u);
});

test("removal retains baseline labels and output is deterministic and bounded", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  next.elements = [];
  assert.equal(summarizeDiagram(baseline, next), "Removed 2 nodes and 1 connection.");
  const many = copyScene(baseline);
  many.elements = Array.from({ length: 200 }, (_, index) => ({ ...baseline.elements[0]!, id: `new${index}` }));
  const summary = summarizeDiagram(baseline, many);
  assert.equal(summary, summarizeDiagram(baseline, many));
  assert.equal(summary.split("\n").length, 1);
  assert.ok(summary.length <= 200);
  assert.equal(summary, "Added 200 nodes; removed 2 nodes and 1 connection.");
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
  assert.equal(summarizeDiagram(baseline, loaded), "");
  Object.assign(loaded.files["svg"]!, {
    dataURL: url('<svg xmlns="http://www.w3.org/2000/svg" height="100" width="100"><path d="M 0 0 L 20 20" /></svg>'),
  });
  assert.equal(diagramChanged(baseline, loaded), true);
  assert.match(summarizeDiagram(baseline, loaded), /images/u);
  Object.assign(baseline.files["svg"]!, { dataURL: url("not an SVG") });
  Object.assign(loaded.files["svg"]!, { dataURL: url("different invalid SVG") });
  assert.equal(diagramChanged(baseline, loaded), true);
});

test("labeled additions and removals count once; standalone notes remain annotations", () => {
  const baseline = fixture();
  const empty = { ...copyScene(baseline), elements: [] };
  const node = { ...copyScene(baseline), elements: baseline.elements.slice(0, 2) };
  assert.equal(summarizeDiagram(empty, node), "Added “Start”.");
  assert.equal(summarizeDiagram(node, empty), "Removed “Start”.");
  const note = copyScene(baseline);
  const text = baseline.elements[1]!;
  assert.equal(text.type, "text");
  if (text.type !== "text") throw new Error("Expected text fixture");
  note.elements = [...note.elements, { ...text, id: "note", containerId: null }];
  assert.equal(summarizeDiagram(baseline, note), "Added 1 annotation.");
  const attached = copyScene(baseline);
  attached.elements = attached.elements.filter((element) => element.id !== "text");
  assert.equal(summarizeDiagram(attached, baseline), "Updated labels.");
});

test("short renames retain context but long labels are omitted", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  Object.assign(next.elements[1]!, { text: "Gateway", originalText: "Gateway", width: 80 });
  assert.equal(summarizeDiagram(baseline, next), "Renamed “Start” → “Gateway”.");
  Object.assign(next.elements[1]!, { text: "Long label ".repeat(30) });
  assert.equal(summarizeDiagram(baseline, next), "Updated labels.");
});

test("node movement and incidental arrow binding adjustments collapse to layout", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  Object.assign(next.elements[0]!, { x: 80 });
  Object.assign(next.elements[1]!, { x: 85 });
  Object.assign(next.elements[3]!, {
    width: 20,
    points: [
      [0, 0],
      [20, 0],
    ],
    startBinding: { elementId: "a", focus: 0.2, gap: 5 },
  });
  assert.equal(summarizeDiagram(baseline, next), "Updated layout.");
  Object.assign(next.elements[3]!, { endBinding: { elementId: "a" } });
  assert.equal(summarizeDiagram(baseline, next), "Updated connections and layout.");
});

test("mixed edits preserve every category within three clauses and 200 characters", () => {
  const baseline = fixture();
  const next = copyScene(baseline);
  next.elements = next.elements.filter((element) => element.id !== "b");
  next.elements = [...next.elements, { ...baseline.elements[0]!, id: "new" }];
  Object.assign(next.elements[0]!, { x: 20, strokeColor: "red", groupIds: ["g"] });
  Object.assign(next.elements[1]!, { text: "Changed" });
  Object.assign(next.elements[2]!, { endBinding: null });
  const summary = summarizeDiagram(baseline, next);
  assert.equal(summary, "Added 1 node; removed 1 node; updated labels, connections, layout and styling.");
  assert.ok(summary.length <= 200);
  assert.ok(summary.split(";").length <= 3);
});
