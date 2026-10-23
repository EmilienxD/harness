import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export type AuthoredDiagram = { id: string; source: string; caption: string };
type Node = DefaultTreeAdapterMap["node"];

function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function text(node: Node): string {
  return node.nodeName === "#text"
    ? (node as DefaultTreeAdapterMap["textNode"]).value
    : children(node).map(text).join("");
}

// Parse HTML as the browser does; entities are decoded once, never via regular expressions.
// IDs belong to the question, so moving a figure cannot move feedback to another diagram.
export function extractAuthoredDiagrams(html: string): AuthoredDiagram[] {
  const diagrams: AuthoredDiagram[] = [];
  const ids = new Set<string>();
  function visit(node: Node, inDiagram = false) {
    if (!("attrs" in node)) {
      children(node).forEach((child) => visit(child, inDiagram));
      return;
    }
    const identity = node.attrs.find((attr) => attr.name === "data-grill-diagram");
    if (identity) {
      const id = identity.value;
      if (inDiagram || node.tagName !== "figure" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id)) {
        throw new Error("Diagram figures need unique IDs starting with a letter (up to 64 letters, digits, _ or -)");
      }
      const elements = children(node).filter((child): child is DefaultTreeAdapterMap["element"] => "tagName" in child);
      const sources = elements.filter(
        (child) =>
          child.tagName === "pre" &&
          child.attrs.some((attr) => attr.name === "class" && attr.value.split(/\s+/).includes("mermaid")),
      );
      const captions = elements.filter((child) => child.tagName === "figcaption");
      const source = sources[0];
      const caption = captions[0];
      if (
        sources.length !== 1 ||
        captions.length !== 1 ||
        !source ||
        !caption ||
        !text(source).trim() ||
        !text(caption).trim() ||
        children(source).some((child) => "tagName" in child)
      ) {
        throw new Error(
          `Diagram ${id} needs one direct pre.mermaid containing escaped source text and one nonempty figcaption`,
        );
      }
      ids.add(id);
      diagrams.push({ id, source: text(source).replace(/\r\n?/g, "\n").trim(), caption: text(caption).trim() });
    }
    children(node).forEach((child) => visit(child, inDiagram || !!identity));
  }
  visit(parseFragment(html));
  return diagrams;
}
