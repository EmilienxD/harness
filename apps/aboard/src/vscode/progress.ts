import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

function short(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

export function summarizeProgressEvent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  const kind = event.type;
  if (kind === "assistant") {
    const message = event.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return undefined;
    const labels = message.content.flatMap((part: unknown): string[] => {
      if (typeof part !== "object" || part === null) return [];
      const block = part as Record<string, unknown>;
      if (block.type === "tool_use") {
        const name = short(block.name) || "Tool";
        const input = block.input as Record<string, unknown> | undefined;
        const detail = input && typeof input === "object" ? short(input.query ?? input.url) : "";
        return [`${["websearch", "web_search"].includes(name.toLowerCase()) ? "Search" : name} started${detail ? `: ${detail}` : ""}`];
      }
      const detail = block.type === "text" ? short(block.text) : "";
      return detail ? [`Agent: ${detail}`] : [];
    });
    return labels.join(" | ") || undefined;
  }
  if (kind === "result") {
    const label = event.is_error === true ? "Failed" : "Finished";
    const usage = event.usage as Record<string, unknown> | undefined;
    return typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
      ? `${label} · ${usage.input_tokens} input, ${usage.output_tokens} output tokens`
      : label;
  }
  if (kind === "thread.started") return "Provider session started";
  if (kind === "turn.started") return "Turn started";
  if (kind === "turn.failed") return "Turn failed";
  if (kind === "turn.completed") {
    const usage = event.usage as Record<string, unknown> | undefined;
    return typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
      ? `Turn finished · ${usage.input_tokens} input, ${usage.output_tokens} output tokens`
      : "Turn finished";
  }
  if (kind === "error") return `Error: ${short(event.message) || "provider error"}`;
  if (!["item.started", "item.completed", "item.updated"].includes(String(kind))) return undefined;
  if (typeof event.item !== "object" || event.item === null) return undefined;
  const item = event.item as Record<string, unknown>;
  const action = kind === "item.started" ? "started" : kind === "item.completed" ? "finished" : "updated";
  if (item.type === "web_search") {
    const detail = short(item.query ?? item.url);
    return `Search ${action}${detail ? `: ${detail}` : ""}`;
  }
  if (item.type === "command_execution") {
    const detail = short(item.command);
    return `Command ${action}${detail ? `: ${detail}` : ""}`;
  }
  if (item.type === "mcp_tool_call") {
    const detail = short(item.tool);
    return `Tool ${action}${detail ? `: ${detail}` : ""}`;
  }
  if (item.type === "agent_message" && kind === "item.completed") {
    const detail = short(item.text);
    return detail ? `Agent: ${detail}` : undefined;
  }
  if (item.type === "file_change" && kind === "item.completed") return "File changes completed";
  if (item.type === "plan_update" && kind === "item.completed") return "Plan updated";
  return undefined;
}

export async function progressLogForAgent(runtimeRoot: string, agentId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/u.test(agentId)) return undefined;
  try {
    const record = JSON.parse(await readFile(join(runtimeRoot, "watch", `${agentId}.json`), "utf8")) as { log?: unknown };
    return typeof record.log === "string" ? record.log : undefined;
  } catch { return undefined; }
}

/** Incremental reader: a torn final JSONL record is retained for the next poll. */
export class ProgressTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  public constructor(private readonly path: string) {}

  public async next(): Promise<readonly string[]> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    try {
      const size = (await file.stat()).size;
      if (size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); }
      const result: string[] = [];
      while (this.offset < size) {
        const bytes = Buffer.alloc(Math.min(65_536, size - this.offset));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.pending = Buffer.concat([this.pending, bytes.subarray(0, bytesRead)]);
        let newline: number;
        while ((newline = this.pending.indexOf(10)) !== -1) {
          const line = this.pending.subarray(0, newline).toString("utf8");
          this.pending = this.pending.subarray(newline + 1);
          try {
            const summary = summarizeProgressEvent(JSON.parse(line));
            if (summary !== undefined) result.push(summary);
          } catch { /* Ignore malformed provider records. */ }
        }
      }
      return result;
    } finally { await file.close(); }
  }
}
