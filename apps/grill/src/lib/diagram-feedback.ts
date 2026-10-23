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

/** A compact visual overview; exact change detection remains in meaningfulScene. */
export function summarizeDiagram(baseline: DiagramScene, scene: DiagramScene): string {
  if (!diagramChanged(baseline, scene)) return "";
  type Element = DiagramScene["elements"][number];
  const before = new Map(live(baseline).map((element) => [element.id, element]));
  const after = new Map(live(scene).map((element) => [element.id, element]));
  const added = [...after.values()].filter((element) => !before.has(element.id));
  const removed = [...before.values()].filter((element) => !after.has(element.id));
  const categories = new Set<string>();
  const renames: Array<[string, string]> = [];
  const join = (items: string[]) =>
    items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const cleanLabel = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length <= 32 ? text : null;
  };
  const label = (element: Element, drawing: Map<string, Element>) => {
    const text = [...drawing.values()].find((item) => item.type === "text" && item.containerId === element.id);
    return text?.type === "text" ? cleanLabel(text.text) : null;
  };
  const kind = (element: Element) => {
    if (element.type === "arrow" || element.type === "line") return "connection";
    if (element.type === "text" || element.type === "freedraw") return "annotation";
    if (element.type === "image") return "image";
    return "node";
  };
  const describe = (elements: Element[], drawing: Map<string, Element>) => {
    // Bound text belongs to its container, including a newly attached label on an existing node.
    const independent = elements.filter(
      (element) => !(element.type === "text" && element.containerId && drawing.has(element.containerId)),
    );
    if (independent.length === 1 && kind(independent[0]!) === "node") {
      const name = label(independent[0]!, drawing);
      if (name) return `“${name}”`;
    }
    const counts = new Map<string, number>();
    for (const element of independent) counts.set(kind(element), (counts.get(kind(element)) ?? 0) + 1);
    return join(
      ["node", "connection", "annotation", "image"].flatMap((type) => {
        const count = counts.get(type) ?? 0;
        return count ? [`${count} ${type}${count === 1 ? "" : "s"}`] : [];
      }),
    );
  };
  for (const element of added.concat(removed)) {
    if (
      element.type === "text" &&
      element.containerId &&
      before.has(element.containerId) &&
      after.has(element.containerId)
    )
      categories.add("labels");
  }
  for (const [id, element] of after) {
    const previous = before.get(id);
    if (!previous) continue;
    const oldValue = elementValue(previous);
    const newValue = elementValue(element);
    const keys = new Set(
      [...Object.keys(oldValue), ...Object.keys(newValue)].filter(
        (key) => stable(oldValue[key]) !== stable(newValue[key]),
      ),
    );
    const take = (fields: string[]) => {
      const changed = fields.some((field) => keys.has(field));
      fields.forEach((field) => keys.delete(field));
      return changed;
    };
    if (take(["text", "originalText"])) {
      categories.add("labels");
      if (element.type === "text" && previous.type === "text") renames.push([previous.text, element.text]);
    }
    // Binding focus/gap changes accompany node movement; only endpoint identity changes are connections.
    if (take(["startBinding", "endBinding"])) {
      const target = (value: unknown) =>
        value && typeof value === "object" && "elementId" in value ? value.elementId : null;
      if (["startBinding", "endBinding"].some((key) => target(oldValue[key]) !== target(newValue[key])))
        categories.add("connections");
      else categories.add("layout");
    }
    const boundText = element.type === "text" && element.containerId && after.has(element.containerId);
    if (take(["x", "y", "width", "height", "angle"]) && !boundText) categories.add("layout");
    if (take(["points", "pressures", "simulatePressure", "elbowed", "fixedSegments"])) categories.add("layout");
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
      categories.add("styling");
    // Reciprocal boundElements updates are bookkeeping consequences of label/connection edits.
    take(["boundElements"]);
    if (take(["containerId"])) categories.add("labels");
    if (take(["frameId", "groupIds"])) categories.add("layout");
    if (
      element.type === "image" &&
      previous.type === "image" &&
      stable(imageValue(baseline.files[previous.fileId ?? ""])) !==
        stable(imageValue(scene.files[element.fileId ?? ""]))
    )
      categories.add("images");
    if (take(["fileId"])) categories.add("images");
    if (keys.size) categories.add("content");
  }
  if (
    stable([...before.keys()].filter((id) => after.has(id))) !==
    stable([...after.keys()].filter((id) => before.has(id)))
  )
    categories.add("layout");
  if ((baseline.appState.viewBackgroundColor ?? "#ffffff") !== (scene.appState.viewBackgroundColor ?? "#ffffff"))
    categories.add("styling");

  const additions = describe(added, after);
  const removals = describe(removed, before);
  const updates = ["labels", "connections", "layout", "styling", "images", "content"].filter((key) =>
    categories.has(key),
  );
  const clauses = [additions && `Added ${additions}`, removals && `removed ${removals}`].filter(Boolean);
  if (updates.length) {
    const rename = renames.length === 1 && updates.length === 1 && !clauses.length ? renames[0] : null;
    const oldName = rename && cleanLabel(rename[0]);
    const newName = rename && cleanLabel(rename[1]);
    clauses.push(oldName && newName ? `renamed “${oldName}” → “${newName}”` : `updated ${join(updates)}`);
  }
  if (!clauses.length) return "Updated drawing content.";
  let summary = `${clauses.join("; ")}.`;
  // Aggregate whole clauses instead of truncating labels or losing entire categories.
  if (summary.length > 200)
    summary = `${[additions && "added elements", removals && "removed elements", updates.length && `updated ${join(updates)}`].filter(Boolean).join("; ")}.`;
  return summary[0]!.toUpperCase() + summary.slice(1);
}
