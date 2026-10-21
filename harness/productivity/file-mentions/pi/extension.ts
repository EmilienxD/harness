import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const LIMITS = { fileBytes: 256 * 1024, totalBytes: 1024 * 1024, mentions: 20, directoryEntries: 100, directoryBytes: 16 * 1024 };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Only scan user prose; examples and previously expanded context are not new references. */
export function mentions(text: string): string[] {
  const excluded: [number, number][] = [];
  let fence: { start: number; character: string; length: number } | undefined;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const match = /^[ \t]*(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (!match) continue;
    const run = match[1]!;
    if (!fence) fence = { start: line.index!, character: run[0]!, length: run.length };
    else if (run[0] === fence.character && run.length >= fence.length && !match[2]!.trim()) {
      excluded.push([fence.start, line.index! + line[0].length]);
      fence = undefined;
    }
  }
  if (fence) excluded.push([fence.start, text.length]);
  for (const match of text.matchAll(/(`+)[\s\S]*?\1/g)) excluded.push([match.index!, match.index! + match[0].length]);
  for (const match of text.matchAll(/<(file-mentions|skill)\b[^>]*>[\s\S]*?<\/\1>/g)) excluded.push([match.index!, match.index! + match[0].length]);
  const result: string[] = [];
  // Pi's path picker emits @"path with spaces". Backslashes stay literal for Windows paths.
  for (const match of text.matchAll(/(?:^|[\s([{=])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'<>`]+))/g)) {
    const index = match.index! + match[0].indexOf("@");
    if (excluded.some(([start, end]) => start <= index && index < end)) continue;
    const path = match[1] ?? match[2] ?? match[3]!;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

function absolute(path: string, cwd: string): string {
  return resolve(cwd, path === "~" ? homedir() : /^~[/\\]/.test(path) ? resolve(homedir(), path.slice(2)) : path);
}

async function locate(path: string, cwd: string): Promise<string> {
  const full = absolute(path, cwd);
  try { await stat(full); return full; }
  catch {
    // Prefer an actual filename ending in punctuation over the prose interpretation.
    return absolute(path.replace(/[.,!?;:)\]}]+$/, ""), cwd);
  }
}

async function directoryListing(path: string): Promise<{ content: string; truncated: boolean; entries: number }> {
  const directory = await opendir(path);
  const names: string[] = [];
  let truncated = false;
  for await (const entry of directory) {
    if (names.length === LIMITS.directoryEntries) { truncated = true; break; }
    // JSON quoting keeps filenames containing newlines/control characters on one line.
    names.push(JSON.stringify(entry.name) + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""));
  }
  names.sort();
  const lines: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const size = Buffer.byteLength(name + "\n");
    if (bytes + size > LIMITS.directoryBytes) { truncated = true; break; }
    lines.push(name);
    bytes += size;
  }
  return { content: lines.join("\n"), truncated, entries: lines.length };
}

async function textFile(path: string, remaining: number): Promise<Buffer> {
  // Nonblocking opens avoid hanging on a FIFO swapped in after the initial stat.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("not a regular text file");
    const cap = Math.min(LIMITS.fileBytes, remaining);
    const buffer = Buffer.alloc(cap + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > cap) throw new Error(remaining < LIMITS.fileBytes ? "per-prompt content budget exceeded" : "file exceeds 256 KiB");
    return buffer.subarray(0, bytes);
  } finally { await file.close(); }
}

const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const snapshots = () => /\n\n<file-mentions source="harness-file-mentions">([\s\S]*?)<\/file-mentions>|\n\n<file-mentions>([\s\S]*?)<\/file-mentions>\s*$/g;

/** Presentation only: the stored message and provider context retain the full snapshot. */
export function displayMentions(text: string): string {
  return text.replace(snapshots(), "");
}

export function mentionStatuses(text: string, cwd: string): string[] {
  const lines: string[] = [];
  for (const snapshot of text.matchAll(snapshots())) {
    const body = snapshot[1] ?? snapshot[2]!;
    for (const match of body.matchAll(/<(file|directory|unavailable)\s+([^>]+)>/g)) {
      const attributes = Object.fromEntries([...match[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1]!, unescape(attribute[2]!)]));
      if (!attributes.path) continue;
      const path = (relative(cwd, attributes.path).replace(/\\/g, "/") || ".").replace(/[\x00-\x1f\x7f]/g, " ");
      const status = match[1] === "unavailable" ? "not loaded" : attributes.truncated === "true" ? "loaded (listing truncated)" : "loaded";
      lines.push(`${path} ${status}.`);
    }
    const omitted = /<omitted count="(\d+)"/.exec(body);
    if (omitted) lines.push(`${omitted[1]} references not loaded (reference limit).`);
  }
  return lines;
}

export default function (pi: any): void {
  pi.registerMarkdownTransformer((text: string, context: any) => context.messageType === "user" ? displayMentions(text) : text);
  // message_start has already drawn the user block; notify now puts the info beneath it.
  // Rendering/replaying history stays pure and never re-emits notifications.
  pi.on("message_end", (event: any, ctx: any) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : (content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    const lines = mentionStatuses(text, ctx.cwd);
    if (lines.length) ctx.ui.notify(lines.join("\n"), "info");
  });
  pi.on("input", async (event: any, ctx: any) => {
    const references = mentions(event.text);
    if (!references.length) return { action: "continue" };
    const blocks: string[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const reference of references.slice(0, LIMITS.mentions)) {
      const path = await locate(reference, ctx.cwd);
      try {
        const identity = await realpath(path);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const info = await stat(path);
        if (info.isDirectory()) {
          const listing = await directoryListing(path);
          const size = Buffer.byteLength(listing.content);
          if (bytes + size > LIMITS.totalBytes) throw new Error("per-prompt content budget exceeded");
          bytes += size;
          blocks.push(`<directory path="${escape(path)}" entries="${listing.entries}" truncated="${listing.truncated}">\n${escape(listing.content)}\n</directory>`);
        } else {
          if (!info.isFile()) throw new Error("not a regular text file or directory");
          if (info.size > LIMITS.fileBytes) throw new Error("file exceeds 256 KiB");
          const buffer = await textFile(path, LIMITS.totalBytes - bytes);
          if (buffer.includes(0)) throw new Error("binary files are not auto-loaded; use a file tool");
          let content: string;
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
          catch { throw new Error("file is not UTF-8 text; use a file tool"); }
          bytes += buffer.length;
          blocks.push(`<file path="${escape(path)}" bytes="${buffer.length}">\n${escape(content)}\n</file>`);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason = code ? `filesystem error: ${code}` : (error as Error).message;
        blocks.push(`<unavailable path="${escape(path)}" reason="${escape(reason)}" />`);
      }
    }
    const omitted = Math.max(0, references.length - LIMITS.mentions);
    if (omitted) blocks.push(`<omitted count="${omitted}" reason="per-prompt reference limit" />`);
    return {
      action: "transform",
      text: `${event.text}\n\n<file-mentions source="harness-file-mentions">\n${blocks.join("\n\n")}\n</file-mentions>`,
      images: event.images,
    };
  });
}
