import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { imageCache, prepareImages } from "../../src/grill/images.js";

function png(): Buffer {
  function chunk(kind: string, body: Buffer): Buffer {
    const data = Buffer.concat([Buffer.from(kind), body]);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", Buffer.from("00000001000000010806000000", "hex")), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

test("authenticated immutable image retrieval replaces generated ranges only and repairs cache", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "grill image verification "));
  const id = randomUUID(), asset = randomUUID(), bytes = png();
  let assets = 0, corrupt = false, redirect = false, invalid = false;
  let snapshot: { id: string; prompt: string; images: object[] };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer 1234") { response.writeHead(401).end(); return; }
    if (redirect) { response.writeHead(302, { Location: "http://127.0.0.1:1/forbidden" }).end(); return; }
    if (request.url?.includes("prompt-snapshots")) response.end(JSON.stringify({ snapshot: invalid ? { ...snapshot, images: [{ ...snapshot.images[0], reference_start: 0 }] } : snapshot }));
    else { assets++; response.end(corrupt ? Buffer.alloc(bytes.length) : bytes); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(cache, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const reference = `${origin}/api/v1/assets/${asset} (authenticated Grill image)`;
  const prefix = `User notes: ${reference}\nGenerated image: `;
  const prompt = `${prefix}${reference}\nOther: https://example.test/keep`;
  snapshot = { id, prompt, images: [{ asset_id: asset, question_id: "Q1", diagram_id: "flow", media_type: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.length, reference, reference_start: prefix.length, reference_end: prefix.length + reference.length }] };
  const fetch = (code = "1234") => prepareImages(prompt, id, origin, code, AbortSignal.timeout(2000), cache);
  const path = join(cache, `${createHash("sha256").update(bytes).digest("hex")}.png`);
  assert.equal(await fetch(), `${prefix}${JSON.stringify(path)}\nOther: https://example.test/keep`);
  assert.deepEqual(await readFile(path), bytes);
  await fetch(); assert.equal(assets, 1);
  await writeFile(path, "corrupt"); await fetch(); assert.equal(assets, 2);
  await assert.rejects(fetch("9876"));
  redirect = true; await assert.rejects(fetch()); redirect = false;
  invalid = true; await assert.rejects(fetch()); invalid = false;
  await writeFile(path, "bad"); corrupt = true; await assert.rejects(fetch());
});

test("state overrides inside the project do not put downloaded images in the checkout", () => {
  const project = join(tmpdir(), "project");
  assert.equal(imageCache({ HARNESS_STATE_DIR: join(project, ".harness") }, project), join(tmpdir(), "harness-grill-image-cache"));
});
