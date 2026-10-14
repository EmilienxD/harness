import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestPython } from "../../hooks/pi-support/bridge.ts";

const RECEIPT = "harness-prefer-fewer-comments-v1";
const MAX_BYTES = 512 * 1024;
const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "hooks", "prefer_fewer_comments_pi.py");
const diagnostic = "Harness could not check the comment budget; the write succeeded. Check the Python runtime or snapshot size/readability.";

async function snapshot(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_BYTES) return undefined;
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      return size > MAX_BYTES ? undefined : buffer.subarray(0, size).toString("utf8");
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
}

export default function (pi: any) {
  let controller = new AbortController();
  let feedback = Promise.resolve();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());

  for (const [name, factory] of [["write", createWriteToolDefinition], ["edit", createEditToolDefinition]] as const) {
    const definition = factory(process.cwd());
    pi.registerTool({
      ...definition,
      async execute(id: string, input: any, signal: AbortSignal, update: any, ctx: any) {
        const lifecycle = controller.signal;
        let before: string | undefined;
        let after: string | undefined;
        let path = "";
        // Per-call operations execute under Pi's own file mutation queue. Do not
        // acquire that queue around execute: it would deadlock the native tool.
        const operations = {
          mkdir: (dir: string) => mkdir(dir, { recursive: true }).then(() => {}),
          access: (file: string) => access(file, constants.R_OK | constants.W_OK),
          readFile: async (file: string) => {
            const buffer = await readFile(file);
            before = buffer.length <= MAX_BYTES ? buffer.toString("utf8") : undefined;
            return buffer;
          },
          writeFile: async (file: string, content: string) => {
            if (name === "write") before = await snapshot(file);
            await writeFile(file, content, "utf8");
            path = file;
            after = Buffer.byteLength(content) <= MAX_BYTES ? content : undefined;
          },
        };
        const native = factory(ctx.cwd, { operations });
        const result = await native.execute(id, input, signal, update, ctx);
        // Serialize only feedback, across files too, so simultaneous successes
        // cannot both spend a file cooldown or the session's first reminder.
        const pending = feedback.then(async () => {
          if (signal?.aborted || lifecycle.aborted) return result;
          let message = diagnostic;
          try {
            if (before === undefined || after === undefined) throw new Error("Unbounded snapshot");
            const entries = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === RECEIPT);
            const response = await requestPython({
              version: 1, cwd: ctx.cwd, path, before, after,
              receipts: entries.flatMap((entry: any) => entry.data.receipts ?? []),
            }, AbortSignal.any([lifecycle, ...(signal ? [signal] : [])]), helper);
            if (typeof response.message !== "string" || !Array.isArray(response.receipts)) throw new Error("Invalid comment response");
            if (signal?.aborted || lifecycle.aborted) return result;
            message = response.message;
            if (message && response.receipts.length) pi.appendEntry(RECEIPT, {
              callId: id, launchArgv: response.launchArgv, receipts: response.receipts,
            });
          } catch {
            if (signal?.aborted || lifecycle.aborted) return result;
          }
          return message ? { ...result, content: [...result.content, { type: "text" as const, text: message }] } : result;
        });
        feedback = pending.then(() => {}, () => {});
        return pending;
      },
    });
  }
}
