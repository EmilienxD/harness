import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { inflateSync } from "node:zlib";

const MAX_IMAGE = 6 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export type ImageReference = { asset_id: string; question_id: string; diagram_id: string; sha256: string; byte_size: number; media_type: string; reference: string; reference_start: number; reference_end: number };

export function imageCache(environment: NodeJS.ProcessEnv = process.env, workspaceRoot = process.cwd()): string {
  const root = environment.HARNESS_STATE_DIR
    ? join(environment.HARNESS_STATE_DIR, "grill")
    : process.platform === "win32" && environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, "harness", "grill")
      : join(environment.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness", "grill");
  const cache = resolve(root, "image-cache");
  const within = relative(workspaceRoot, cache);
  return within === "" || (!within.startsWith("..") && !isAbsolute(within)) ? resolve(tmpdir(), "harness-grill-image-cache") : cache;
}

function png(data: Buffer): boolean {
  if (!data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return false;
  try {
    let offset = 8;
    let expected = 0;
    let ended = false;
    const compressed: Buffer[] = [];
    while (offset < data.length) {
      const size = data.readUInt32BE(offset);
      const kind = data.toString("ascii", offset + 4, offset + 8);
      const body = data.subarray(offset + 8, offset + 8 + size);
      if (offset + size + 12 > data.length) return false;
      // PNG's CRC32 polynomial, including the four-byte chunk type.
      let crc = 0xffffffff;
      for (const byte of data.subarray(offset + 4, offset + 8 + size)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(offset + 8 + size)) return false;
      if (offset === 8 && kind !== "IHDR") return false;
      if (kind === "IHDR") {
        if (offset !== 8 || size !== 13) return false;
        const width = body.readUInt32BE(0), height = body.readUInt32BE(4);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 16_000_000 || body[8] !== 8 || ![2, 6].includes(body[9]!) || body[10] || body[11] || body[12]) return false;
        expected = height * (1 + width * (body[9] === 6 ? 4 : 3));
      }
      if (kind === "IDAT") compressed.push(body);
      if (!["IHDR", "IDAT", "IEND", "PLTE"].includes(kind) && !/^[a-z]/u.test(kind)) return false;
      offset += size + 12;
      if (kind === "IEND") { ended = size === 0; break; }
    }
    if (!ended || offset !== data.length || expected <= 0) return false;
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
    if (pixels.length !== expected) return false;
    const height = data.readUInt32BE(20);
    for (let row = 0; row < height; row++) if (pixels[row * (expected / height)]! > 4) return false;
    return true;
  } catch { return false; }
}

async function bounded(url: string, code: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${code}` }, redirect: "error", signal });
  if (!response.ok || !response.body) throw new Error("Image request failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel().catch(() => undefined); throw new Error("Image response too large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Trust ranges only from the authenticated immutable snapshot, never from delivery metadata. */
export async function prepareImages(prompt: string, snapshotId: string, origin: string, code: string, signal: AbortSignal, cache = imageCache()): Promise<string> {
  if (!uuid.test(snapshotId) || new URL(origin).origin !== origin) throw new Error("Invalid image snapshot");
  const snapshot = JSON.parse((await bounded(`${origin}/api/v1/prompt-snapshots/${snapshotId}`, code, 512 * 1024, signal)).toString("utf8")).snapshot as { id: string; prompt: string; images: ImageReference[] };
  if (snapshot.id !== snapshotId || snapshot.prompt !== prompt || !Array.isArray(snapshot.images) || snapshot.images.length > 20) throw new Error("Invalid image snapshot");
  let previous = 0, total = 0;
  for (const item of snapshot.images) {
    if (!uuid.test(item.asset_id) || !/^[a-f0-9]{64}$/u.test(item.sha256) || item.media_type !== "image/png" || !Number.isInteger(item.byte_size) || item.byte_size <= 0 || item.byte_size > MAX_IMAGE || !item.question_id || !item.diagram_id || !Number.isInteger(item.reference_start) || !Number.isInteger(item.reference_end) || item.reference_start < previous || item.reference_end <= item.reference_start || item.reference_end > prompt.length || prompt.slice(item.reference_start, item.reference_end) !== item.reference || item.reference !== item.asset_id) throw new Error("Invalid image metadata");
    previous = item.reference_end;
    total += item.byte_size;
  }
  if (total > 50 * 1024 * 1024) throw new Error("Too many image bytes");
  await mkdir(cache, { recursive: true });
  const replacements: { start: number; end: number; path: string }[] = [];
  for (const item of snapshot.images) {
    signal.throwIfAborted();
    const path = resolve(cache, `${item.sha256}.png`);
    const valid = (data: Buffer): boolean => data.length === item.byte_size && createHash("sha256").update(data).digest("hex") === item.sha256 && png(data);
    let cached = Buffer.alloc(0);
    try { if ((await stat(path)).size <= MAX_IMAGE) cached = await readFile(path); } catch { /* Cache miss. */ }
    if (!valid(cached)) {
      const data = await bounded(`${origin}/api/v1/assets/${item.asset_id}`, code, item.byte_size, signal);
      if (!valid(data)) throw new Error("Image integrity verification failed");
      const temporary = join(cache, `.${randomUUID()}.tmp`);
      try { await writeFile(temporary, data); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }
    replacements.push({ start: item.reference_start, end: item.reference_end, path });
  }
  let prepared = prompt;
  for (const item of replacements.reverse()) prepared = prepared.slice(0, item.start) + JSON.stringify(item.path) + prepared.slice(item.end);
  return prepared;
}
