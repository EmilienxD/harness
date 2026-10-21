export type DiagramTarget = { id: string; source: string; caption: string; host: HTMLElement };
/** Discover only authored direct children; preserve the figure, caption, HTML and init_js DOM. */
export function discoverDiagrams(root: HTMLElement): DiagramTarget[] {
  return Array.from(root.querySelectorAll<HTMLElement>("figure[data-grill-diagram]")).flatMap((figure) => {
    const pre = figure.querySelector<HTMLElement>(":scope > pre.mermaid");
    const caption = figure.querySelector(":scope > figcaption");
    if (!pre || !caption) return [];
    const host = document.createElement("div");
    host.className = "diagram-mount";
    pre.before(host);
    pre.hidden = true;
    return [
      {
        id: figure.dataset["grillDiagram"]!,
        source: pre.textContent?.trim() || "",
        caption: caption.textContent || "Diagram",
        host,
      },
    ];
  });
}
