import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

type Token = { type: string; text: string; lang?: string };
type Renderer = {
  theme: MarkdownTheme;
  invalidate(): void;
  render(width: number): string[];
  renderToken(token: Token, width: number, ...args: unknown[]): string[];
};
type Patch = { enabled: boolean; revision: number };
const KEY = Symbol.for("harness:polished-code-blocks:pi-1.2");

export function renderCodeBlock(token: Token, width: number, theme: MarkdownTheme): string[] {
  // At very narrow widths, decorations would leave no room for code.
  if (width < 5) {
    return token.text.split("\n").flatMap(line => wrapTextWithAnsi(theme.codeBlock(line), Math.max(1, width)));
  }
  const innerWidth = width - 4;
  const border = (text: string) => theme.codeBlockBorder(text);
  const label = truncateToWidth(` ${token.lang?.split(/\s/)[0] || "code"} `, width - 2, "");
  const lines = [border(`╭${label}${"─".repeat(width - 2 - visibleWidth(label))}╮`)];
  const highlighted = theme.highlightCode?.(token.text, token.lang)
    ?? token.text.split("\n").map(line => theme.codeBlock(line));
  for (const line of highlighted) {
    for (const wrapped of wrapTextWithAnsi(line, innerWidth)) {
      lines.push(`${border("│")} ${wrapped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)))} ${border("│")}`);
    }
  }
  lines.push(border(`╰${"─".repeat(width - 2)}╯`));
  return lines;
}

export function installRenderer(): Patch {
  const registry = globalThis as typeof globalThis & { [KEY]?: Patch };
  if (registry[KEY]) return registry[KEY];
  // Pi 1.2.0 has no public code-block renderer hook. Keep the adapter confined
  // to this seam; all parsing, nesting, streaming and inline rendering stay native.
  const prototype = Markdown.prototype as unknown as Renderer;
  if (typeof prototype.renderToken !== "function" || typeof prototype.render !== "function") {
    throw new Error("Unsupported Pi Markdown renderer (verified with Pi 1.2.0).");
  }
  const originalToken = prototype.renderToken;
  const originalRender = prototype.render;
  const patch: Patch = { enabled: true, revision: 0 };
  const revisions = new WeakMap<Renderer, number>();
  prototype.renderToken = function (token, width, ...args) {
    if (!patch.enabled || token.type !== "code") return originalToken.call(this, token, width, ...args);
    const lines = renderCodeBlock(token, width, this.theme);
    if (args[0] && args[0] !== "space") lines.push("");
    return lines;
  };
  prototype.render = function (width) {
    if (revisions.get(this) !== patch.revision) {
      this.invalidate();
      revisions.set(this, patch.revision);
    }
    return originalRender.call(this, width);
  };
  registry[KEY] = patch;
  return patch;
}
