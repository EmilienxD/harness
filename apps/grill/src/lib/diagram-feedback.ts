import type { DiagramScene } from "./diagram-scene.ts";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

const bookkeeping = new Set(["version", "versionNonce", "updated", "index", "isDeleted"]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const stable = (value: unknown) => JSON.stringify(canonical(value));
const live = (scene: DiagramScene) => scene.elements.filter((element) => !element.isDeleted);
const svgCache = new Map<string, string>();
function imageValue(file: DiagramScene["files"][string] | undefined) {
  if (!file) return null;
  let dataURL: string = file.dataURL;
  if (file.mimeType === "image/svg+xml") {
    const cached = svgCache.get(dataURL);
    if (cached) dataURL = cached;
    else {
      try {
        const payload = dataURL.slice(dataURL.indexOf(",") + 1);
        const svg = dataURL.slice(0, dataURL.indexOf(",")).endsWith(";base64")
          ? new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)))
          : decodeURIComponent(payload);
        const nodeValue = (node: DefaultTreeAdapterTypes.Node): unknown => {
          if ("tagName" in node)
            return {
              tag: node.tagName,
              attrs: node.attrs
                .map((attr) => [attr.namespace ?? "", attr.name, attr.value])
                .sort((a, b) => stable(a).localeCompare(stable(b))),
              children: node.childNodes.map(nodeValue),
            };
          if ("childNodes" in node) return node.childNodes.map(nodeValue);
          return "value" in node ? node.value : null;
        };
        // Excalidraw's XML serializer changes attribute order and empty-tag syntax on load.
        // Compare SVG content so that this bookkeeping never creates user feedback.
        const fragment = parseFragment(svg);
        if (!fragment.childNodes.some((node) => "tagName" in node && node.tagName === "svg"))
          throw new Error("Invalid SVG");
        const value = stable(nodeValue(fragment));
        if (svgCache.size >= 8) svgCache.delete(svgCache.keys().next().value!);
        svgCache.set(dataURL, value);
        dataURL = value;
      } catch {
        // Malformed data still compares by its original bytes.
      }
    }
  }
  return { dataURL, mimeType: file.mimeType };
}
function elementValue(element: DiagramScene["elements"][number]) {
  return Object.fromEntries(
    Object.entries(element)
      .filter(([key]) => !bookkeeping.has(key))
      .map(([key, value]) => [
        key,
        key === "boundElements" && Array.isArray(value) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value,
      ]),
  );
}
/** One contract for unchanged status, summaries, persisted revisions and image binding. */
export function meaningfulScene(scene: DiagramScene): string {
  const elements = live(scene);
  const fileIds = new Set(
    elements.flatMap((element) => (element.type === "image" && element.fileId ? [element.fileId] : [])),
  );
  return stable({
    elements: elements.map(elementValue),
    background: scene.appState.viewBackgroundColor ?? "#ffffff",
    files: Object.fromEntries([...fileIds].sort().map((id) => [id, imageValue(scene.files[id])])),
  });
}
export const diagramChanged = (baseline: DiagramScene, scene: DiagramScene) =>
  meaningfulScene(baseline) !== meaningfulScene(scene);

/** Deterministic and bounded; no user-written notes are modified. */
export function summarizeDiagram(baseline: DiagramScene, scene: DiagramScene): string {
  if (!diagramChanged(baseline, scene)) return "No changes were made to the diagram.";
  const before = new Map(live(baseline).map((element) => [element.id, element]));
  const after = new Map(live(scene).map((element) => [element.id, element]));
  const lines: string[] = [];
  const clean = (value: string) => value.replace(/\s+/g, " ").slice(0, 80);
  const label = (element: DiagramScene["elements"][number], drawing = scene) => {
    const text =
      element.type === "text"
        ? element
        : live(drawing).find((item) => item.type === "text" && item.containerId === element.id);
    return `${element.type}${text?.type === "text" ? ` "${clean(text.text)}"` : ""}`;
  };
  const endpoint = (binding: unknown, drawing: DiagramScene) => {
    const id = binding && typeof binding === "object" && "elementId" in binding ? binding.elementId : null;
    const element = live(drawing).find((item) => item.id === id);
    return element ? label(element, drawing) : "unbound endpoint";
  };
  for (const [id, element] of before) if (!after.has(id)) lines.push(`Removed ${label(element, baseline)}.`);
  for (const [id, element] of after) {
    const previous = before.get(id);
    if (!previous) {
      lines.push(`Added ${label(element)}.`);
      continue;
    }
    const oldValue = elementValue(previous);
    const newValue = elementValue(element);
    const keys = new Set(
      [...Object.keys(oldValue), ...Object.keys(newValue)].filter(
        (key) => stable(oldValue[key]) !== stable(newValue[key]),
      ),
    );
    if (!keys.size) continue;
    const take = (fields: string[]) => {
      const changed = fields.some((field) => keys.has(field));
      fields.forEach((field) => keys.delete(field));
      return changed;
    };
    const name = label(element);
    if (element.type === "text" && previous.type === "text" && take(["text", "originalText"]))
      lines.push(`Changed label "${clean(previous.text)}" to "${clean(element.text)}".`);
    const boundText = element.type === "text" && element.containerId && after.has(element.containerId);
    if (take(["x", "y"]) && !boundText) lines.push(`Moved ${name}.`);
    if (take(["width", "height"]) && !boundText) lines.push(`Resized ${name}.`);
    if (take(["angle"])) lines.push(`Rotated ${name}.`);
    if (take(["points", "pressures", "simulatePressure", "elbowed", "fixedSegments"])) lines.push(`Reshaped ${name}.`);
    if (take(["startBinding", "endBinding"]))
      lines.push(
        `Reconnected ${name}: ${endpoint(oldValue["startBinding"], baseline)} -> ${endpoint(oldValue["endBinding"], baseline)} to ${endpoint(newValue["startBinding"], scene)} -> ${endpoint(newValue["endBinding"], scene)}.`,
      );
    if (
      take([
        "strokeColor",
        "backgroundColor",
        "fillStyle",
        "strokeWidth",
        "strokeStyle",
        "roughness",
        "opacity",
        "fontFamily",
        "fontSize",
        "textAlign",
        "verticalAlign",
        "lineHeight",
        "startArrowhead",
        "endArrowhead",
        "roundness",
        "seed",
      ])
    )
      lines.push(`Changed appearance of ${name}.`);
    if (take(["boundElements", "containerId", "frameId", "groupIds"]))
      lines.push(`Changed grouping or label binding of ${name}.`);
    if (keys.size) lines.push(`Updated ${name}: ${[...keys].sort().join(", ")}.`);
  }
  if (
    stable([...before.keys()].filter((id) => after.has(id))) !==
    stable([...after.keys()].filter((id) => before.has(id)))
  )
    lines.push("Changed drawing order.");
  if ((baseline.appState.viewBackgroundColor ?? "#ffffff") !== (scene.appState.viewBackgroundColor ?? "#ffffff"))
    lines.push("Changed canvas background.");
  const referencedFiles = (drawing: DiagramScene) =>
    Object.fromEntries(
      live(drawing)
        .filter((element) => element.type === "image" && element.fileId)
        .map((element) => {
          const file = drawing.files[element.type === "image" ? element.fileId! : ""];
          return [element.id, imageValue(file)];
        }),
    );
  if (stable(referencedFiles(baseline)) !== stable(referencedFiles(scene))) lines.push("Changed image content.");
  if (!lines.length) lines.push("Updated drawing content.");
  const bounded = lines.slice(0, 39).map((line) => line.slice(0, 200));
  if (lines.length > 39) bounded.push(`${lines.length - 39} additional changes.`);
  return bounded.join("\n");
}
