import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

/** Match the publisher's srcset discovery, including data URLs containing commas. */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/u.test(value[index]!)) index++;
    if (index >= value.length) break;
    const start = index;
    const data = value.slice(index, index + 5).toLowerCase() === "data:";
    while (index < value.length && !/\s/u.test(value[index]!) && (data || value[index] !== ",")) index++;
    urls.push(value.slice(start, index));
    while (index < value.length && value[index] !== ",") index++;
    if (index < value.length) index++;
  }
  return urls;
}

/** Local URLs live in HTML attributes so commit can rewrite them before init_js reads the DOM. */
export function localAssetReferences(html: string): string[] {
  const references = new Set<string>();
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("attrs" in node) {
      for (const attr of node.attrs) {
        const values =
          attr.name === "srcset"
            ? ["img", "source"].includes(node.tagName)
              ? srcsetUrls(attr.value)
              : []
            : [attr.value];
        for (const value of values) if (value.startsWith("assets/")) references.add(value);
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html));
  return [...references];
}
