import fs from "node:fs";
import path from "node:path";
import { Marked, Lexer, Renderer, type MarkedToken, type Token, type Tokens } from "marked";
import { slugHref, type ContentBlock, type DocArticle, type DocSection, type NavTabData } from "@/components/docs/content";
import type { SearchEntry } from "@/components/docs/documentation-search";
import { navigation, unlistedPages } from "./site";

const contentRoot = path.resolve(process.cwd(), "../../docs/user");

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith(".md") ? [file] : [];
  }).sort();
}

function plain(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<[^>]*>/g, " ").replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return entities[entity] ?? match;
  }).replace(/\s+/g, " ").trim();
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Python-Markdown's toc slugify, with its per-document duplicate suffixes.
export function headingSlug(title: string) {
  return title.replace(/<[^>]*>/g, "").normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
    .replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[-\s]+/g, "-");
}

function splitPlatforms(value: string) {
  let depth = 0;
  return value.split("").map(character => {
    if (character === "(") depth++;
    if (character === ")") depth--;
    return character === "," && depth === 0 ? "\0" : character;
  }).join("").split("\0").map(platform => platform.trim()).filter(Boolean);
}

function loadDocs() {
  const sources = new Map(walk(contentRoot).map(file => [path.relative(contentRoot, file).replaceAll("\\", "/"), fs.readFileSync(file, "utf8")]));
  const articles = new Map<string, DocArticle>();
  for (const [sourcePath, markdown] of sources) {
    const slug = sourcePath === "index.md" ? "" : sourcePath.slice(0, -3);
    const ids = new Set<string>();
    function allocateId(html: string) {
      const base = headingSlug(plain(html.replace(/<[^>]*>/g, "")));
      let id = base;
      let suffix = 1;
      while (ids.has(id)) id = `${base}_${suffix++}`;
      ids.add(id);
      return id;
    }
    function rewrite(href: string) {
      if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) return href;
      const [, target, suffix] = href.match(/^([^?#]*)(.*)$/)!;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decodeURIComponent(target)));
      if (target.endsWith(".md")) {
        if (!sources.has(relative)) throw new Error(`${sourcePath}: missing Markdown link ${href}`);
        return slugHref(relative === "index.md" ? "" : relative.slice(0, -3)) + suffix;
      }
      if (relative.startsWith("assets/")) {
        if (!fs.existsSync(path.join(contentRoot, relative))) throw new Error(`${sourcePath}: missing asset ${href}`);
        return `/${relative}${suffix}`;
      }
      return href;
    }
    const renderer = new Renderer();
    renderer.link = function ({ href, title, tokens }: Tokens.Link) {
      const destination = rewrite(href);
      const external = /^(?:https?:|\/\/)/i.test(destination);
      return `<a href="${escapeAttribute(destination)}"${title ? ` title="${escapeAttribute(title)}"` : ""}${external ? ' target="_blank" rel="noopener"' : ""}>${this.parser.parseInline(tokens)}</a>`;
    };
    renderer.image = function ({ href, text }: Tokens.Image) {
      return `<img src="${escapeAttribute(rewrite(href))}" alt="${escapeAttribute(text)}" loading="lazy">`;
    };
    renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => text
      .replace(/\b(src|href)=(['"])(.*?)\2/g, (_, attribute: string, quote: string, href: string) => `${attribute}=${quote}${escapeAttribute(rewrite(href))}${quote}`)
      .replace(/<a\b([^>]*\bhref=['"](?:https?:|\/\/)[^>]*)>/gi, (_, attributes: string) => {
        const cleaned = attributes.replace(/\s+(?:target|rel)=(['"])[\s\S]*?\1/gi, "");
        return `<a${cleaned} target="_blank" rel="noopener">`;
      });
    renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens);
      const id = allocateId(html);
      return `<h${depth} id="${id}"><a href="#${id}" class="prose-heading-anchor" aria-label="Link to ${escapeAttribute(plain(html))}">#</a>${html}</h${depth}>`;
    };
    const marked = new Marked({ renderer, gfm: true, async: false });
    const inline = (tokens: Token[]) => marked.Parser.parseInline(tokens, marked.defaults);
    const render = (tokens: Token[]) => marked.Parser.parse(tokens, marked.defaults);
    const tokens = marked.lexer(markdown) as MarkedToken[];
    const titleToken = tokens.find((token): token is Tokens.Heading => token.type === "heading" && token.depth === 1);
    if (!titleToken) throw new Error(`${sourcePath}: expected an H1 title`);
    const title = plain(inline(titleToken.tokens));
    const titleId = allocateId(inline(titleToken.tokens));
    const platforms: string[] = [];
    let description = "";
    const sections: DocSection[] = [{ blocks: [] }];
    let section = sections[0];
    let prose: Token[] = [];
    function flush() {
      if (prose.length) section.blocks.push({ type: "prose", html: render(prose) });
      prose = [];
    }
    for (let token of tokens) {
      if (token === titleToken) continue;
      if (token.type === "paragraph") {
        const match = token.text.match(/^Platforms?: \*\*(.+?)\*\*\.?\s*/);
        if (match) {
          platforms.push(...splitPlatforms(match[1]));
          const text = token.text.slice(match[0].length);
          if (!text) continue;
          token = { ...token, text, tokens: Lexer.lexInline(text, marked.defaults) };
        }
        if (!description && token.type === "paragraph") description = plain(inline(token.tokens));
      }
      if (token.type === "heading" && token.depth === 2) {
        flush();
        const titleHtml = inline(token.tokens);
        section = { id: allocateId(titleHtml), title: plain(titleHtml), titleHtml, blocks: [] };
        sections.push(section);
      } else if (token.type === "code") {
        flush();
        section.blocks.push({ type: "code", language: token.lang?.split(/\s/)[0] || "text", code: token.text });
      } else if (token.type === "table") {
        flush();
        section.blocks.push({ type: "table", columns: token.header.map(cell => inline(cell.tokens)), rows: token.rows.map(row => row.map(cell => inline(cell.tokens))) });
      } else if (token.type === "blockquote" && /^\[!(NOTE|TIP|WARNING)\]/.test(token.text)) {
        flush();
        const match = token.text.match(/^\[!(NOTE|TIP|WARNING)\]\s*/)!;
        section.blocks.push({ type: "callout", tone: match[1] === "TIP" ? "tip" : match[1] === "WARNING" ? "warning" : "info", title: match[1], html: marked.parse(token.text.slice(match[0].length)) as string });
      } else {
        prose.push(token);
      }
    }
    flush();
    articles.set(slug, { slug, href: slugHref(slug), title, titleId, description, platforms, sourcePath, group: "", tab: "", sections: sections.filter(section => section.title || section.blocks.length) });
  }
  const listed = new Set<string>();
  const nav: NavTabData[] = navigation.map(tab => {
    const groups = tab.groups.map(group => ({
      title: group.title,
      links: group.items.flatMap(item => {
        const items = typeof item === "object" && "dir" in item
          ? [...articles.values()].filter(article => path.posix.dirname(article.sourcePath) === item.dir).sort((a, b) => a.title.localeCompare(b.title)).map(article => ({ path: article.sourcePath.slice(0, -3), label: article.title }))
          : [typeof item === "string" ? { path: item, label: undefined } : item];
        if (!items.length) throw new Error(`Empty navigation directory in ${tab.label} / ${group.title}`);
        return items.map(item => {
          const slug = item.path === "index" ? "" : item.path;
          const article = articles.get(slug);
          if (!article) throw new Error(`Missing navigation page: ${item.path}`);
          if (listed.has(slug)) throw new Error(`Duplicate navigation page: ${item.path}`);
          listed.add(slug);
          article.tab = tab.label;
          article.group = group.title;
          return { slug, href: article.href, title: item.label ?? article.title };
        });
      }),
    }));
    return { label: tab.label, href: groups[0].links[0].href, groups };
  });
  for (const [slug, location] of Object.entries(unlistedPages)) {
    const article = articles.get(slug);
    if (!article || listed.has(slug)) throw new Error(`Invalid unlisted page: ${slug}`);
    Object.assign(article, location);
  }
  for (const article of articles.values()) {
    if (!article.tab) throw new Error(`Page missing from navigation: ${article.sourcePath}`);
  }
  return { articles, nav };
}

let cached: ReturnType<typeof loadDocs> | undefined;
function docs() {
  // Re-read in development so Markdown edits appear without restarting Next.
  if (process.env.NODE_ENV === "development") return loadDocs();
  return cached ??= loadDocs();
}
export function getArticles() { return [...docs().articles.values()]; }
export function getArticle(slug: string) { return docs().articles.get(slug); }
export function getNavigation() { return docs().nav; }
export function getOrderedSlugs() { return getNavigation().flatMap(tab => tab.groups.flatMap(group => group.links.map(link => link.slug))); }

function blockText(block: ContentBlock) {
  if (block.type === "prose" || block.type === "callout") return plain(block.html);
  if (block.type === "code") return block.code;
  if (block.type === "image") return block.alt;
  return [...block.columns, ...block.rows.flat()].map(plain).join(" ");
}
export function buildSearchEntries(): SearchEntry[] {
  return getArticles().flatMap(article => {
    const shared = { slug: article.slug, articleTitle: article.title, tab: article.tab, group: article.group, description: article.description };
    return [
      { ...shared, id: article.slug, href: article.href, title: article.title, kind: "article" as const, text: [article.description, ...article.sections.filter(section => !section.title).flatMap(section => section.blocks.map(blockText))].join(" ") },
      ...article.sections.filter(section => section.title).map(section => ({ ...shared, id: `${article.slug}#${section.id}`, href: `${article.href}#${section.id}`, title: section.title!, kind: "section" as const, text: section.blocks.map(blockText).join(" ") })),
    ];
  });
}
