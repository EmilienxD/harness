import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Marked, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

type Token = { type: string; text: string; lang?: string };
export type Message = { role: string; content: unknown; timestamp?: number };
export type BlockSource = { messageKey: string; source: string; start: number; blocks: Token[] };
const parser = new Marked();

export function messageKey(message: Message): string {
  return JSON.stringify([message.timestamp, message.content]);
}

export function indexBlocks(messages: Message[]): BlockSource[] {
  const sources: BlockSource[] = [];
  let next = 1;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "text" || !part.text.trim()) continue;
      const blocks: Token[] = [];
      const tokens = parser.lexer(part.text.trim());
      parser.walkTokens(tokens, token => {
        if (token.type === "code") blocks.push({ type: "code", text: token.text, lang: token.lang });
      });
      sources.push({ messageKey: messageKey(message), source: part.text.trim(), start: next, blocks });
      next += blocks.length;
    }
  }
  return sources;
}
type Renderer = {
  theme: MarkdownTheme;
  text: string;
  defaultTextStyle?: unknown;
  invalidate(): void;
  render(width: number): string[];
  renderToken(token: Token, width: number, ...args: unknown[]): string[];
};
type Patch = { enabled: boolean; revision: number; sources: BlockSource[] };
const KEY = Symbol.for("harness:polished-code-blocks:pi-1.2:copy-1");

export function renderCodeBlock(token: Token, width: number, theme: MarkdownTheme, number?: number): string[] {
  // At very narrow widths, decorations would leave no room for code.
  if (width < 5) {
    return token.text.split("\n").flatMap(line => wrapTextWithAnsi(theme.codeBlock(line), Math.max(1, width)));
  }
  const innerWidth = width - 4;
  const border = (text: string) => theme.codeBlockBorder(text);
  const suffix = number === undefined ? "" : ` #${number}`;
  const label = truncateToWidth(` ${token.lang?.split(/\s/)[0] || "code"}${suffix} `, width - 2, "");
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
  const patch: Patch = { enabled: true, revision: 0, sources: [] };
  const revisions = new WeakMap<Renderer, number>();
  const positions = new WeakMap<Renderer, { next: number | undefined }>();
  let active: { key: string; used: Set<BlockSource> } | undefined;
  // Scope lookup by assistant message so identical snippets in different replies
  // receive different numbers. The Markdown seam alone has no message identity.
  const assistantPrototype = AssistantMessageComponent.prototype;
  const originalAssistantRender = assistantPrototype.render;
  assistantPrototype.render = function (width) {
    const previous = active;
    const message = (this as unknown as { lastMessage?: Message }).lastMessage;
    active = message ? { key: messageKey(message), used: new Set() } : undefined;
    try {
      return originalAssistantRender.call(this, width);
    } finally {
      active = previous;
    }
  };
  prototype.renderToken = function (token, width, ...args) {
    if (!patch.enabled || token.type !== "code") return originalToken.call(this, token, width, ...args);
    const position = positions.get(this);
    const number = position?.next;
    if (position && number !== undefined) position.next = number + 1;
    const lines = renderCodeBlock(token, width, this.theme, number);
    if (args[0] && args[0] !== "space") lines.push("");
    return lines;
  };
  prototype.render = function (width) {
    const source = !this.defaultTextStyle && active
      ? patch.sources.find(source => source.messageKey === active!.key
        && source.source === this.text && !active!.used.has(source))
      : undefined;
    if (source) active!.used.add(source);
    positions.set(this, { next: source?.start });
    if (revisions.get(this) !== patch.revision) {
      this.invalidate();
      revisions.set(this, patch.revision);
    }
    return originalRender.call(this, width);
  };
  registry[KEY] = patch;
  return patch;
}
