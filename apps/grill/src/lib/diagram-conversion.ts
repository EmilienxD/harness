// Label repair and two-pass font materialization adapted from Lavish (MIT),
// Copyright (c) 2026 Kun Chen. See THIRD-PARTY-NOTICES.md.
import {
  convertToExcalidrawElements,
  exportToCanvas,
  exportToBlob,
  restoreElements,
  FONT_FAMILY,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
type ExcalidrawElementSkeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { copyScene, type DiagramRecord, type DiagramScene } from "./diagram-scene";

// Excalidraw resolves fonts lazily; all families, including CJK subsets, are served locally.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/diagram-assets/";

const normalizeBreaks = (text: string) => text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/\\n/g, "\n");
function normalizeSkeleton(element: ExcalidrawElementSkeleton): ExcalidrawElementSkeleton {
  if (element.type === "text") return { ...element, text: normalizeBreaks(element.text) };
  if ("label" in element && element.label) {
    const label = { ...element.label, text: normalizeBreaks(element.label.text) };
    if (["rectangle", "ellipse", "diamond"].includes(element.type) && label.text.includes("\n")) {
      const size = label.fontSize || 16;
      const lines = label.text.split("\n");
      const width = Math.max(element.width || 0, ...lines.map((line) => line.length * size * 0.62 + 16));
      const height = Math.max(element.height || 0, lines.length * size * 1.25 + 16);
      return {
        ...element,
        label,
        width,
        height,
        x: element.x - (width - (element.width || 0)) / 2,
        y: element.y - (height - (element.height || 0)) / 2,
      };
    }
    return { ...element, label };
  }
  return element;
}

function fitLabels(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    if (element.type !== "text" || !context) continue;
    const family = Object.entries(FONT_FAMILY).find(([, value]) => value === element.fontFamily)?.[0] || "sans-serif";
    context.font = `${element.fontSize}px "${family}"`;
    const lines = element.text.split("\n");
    const width = Math.max(element.width, ...lines.map((line) => context.measureText(line).width));
    const height = Math.max(element.height, lines.length * element.fontSize * element.lineHeight);
    let text = { ...element, width, height };
    const container = element.containerId ? byId.get(element.containerId) : undefined;
    // Arrow labels follow the path; expanding an arrow would change its connections.
    if (container && ["rectangle", "ellipse", "diamond"].includes(container.type)) {
      const box = {
        ...container,
        width: Math.max(container.width, width + 16),
        height: Math.max(container.height, height + 16),
      };
      box.x -= (box.width - container.width) / 2;
      box.y -= (box.height - container.height) / 2;
      byId.set(box.id, box);
      text = { ...text, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2 };
    }
    byId.set(text.id, text);
  }
  return elements.map((element) => byId.get(element.id)!);
}

// Mermaid uses shared global DOM/configuration. Serial conversion avoids races between figures.
let conversionQueue = Promise.resolve();
export function convertDiagram(source: string): Promise<DiagramRecord> {
  const work = conversionQueue.then(async () => {
    const parsed = await parseMermaidToExcalidraw(source, {
      themeVariables: { fontSize: "16px" },
      maxTextSize: 100_000,
    });
    const skeletons = parsed.elements.map(normalizeSkeleton);
    const materialize = () => {
      let elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
      if (new Set(elements.map((element) => element.id)).size !== elements.length)
        elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
      return elements;
    };
    const files = parsed.files || {};
    await exportToCanvas({
      elements: materialize(),
      files,
      appState: { exportBackground: false },
      maxWidthOrHeight: 1,
    });
    await document.fonts.ready;
    const elements = restoreElements(fitLabels(materialize()), null, {
      refreshDimensions: false,
      repairBindings: true,
    });
    if (!elements.length) throw new Error("The diagram contains no visible elements.");
    const scene: DiagramScene = { elements, files, appState: { viewBackgroundColor: "#ffffff" } };
    return {
      source,
      scene,
      baseline: copyScene(scene),
      imageFallback: elements.some((element) => element.type === "image"),
    };
  });
  conversionQueue = work.then(
    () => {},
    () => {},
  );
  return work;
}

/** Export exactly the caller's captured revision; storage/submission belongs to the next step. */
export function exportDiagramPng(scene: DiagramScene): Promise<Blob> {
  return exportToBlob({
    elements: scene.elements,
    appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false, exportScale: 1 },
    files: scene.files,
    mimeType: "image/png",
  });
}
