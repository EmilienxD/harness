import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { validDiagramPng } from "../src/lib/diagram-png.server.ts";
const crc = (bytes: Buffer) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, payload: Buffer) => {
  const data = Buffer.concat([Buffer.from(type), payload]);
  const out = Buffer.alloc(data.length + 8);
  out.writeUInt32BE(payload.length);
  data.copy(out, 4);
  out.writeUInt32BE(crc(data), out.length - 4);
  return out;
};
const png = () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
test("canvas PNG accepts pixels and rejects corruption, truncation, invalid filters and unexpected data", () => {
  const bytes = png();
  assert.equal(validDiagramPng(bytes), true);
  const corrupt = Buffer.from(bytes);
  corrupt[45] = corrupt[45]! ^ 1;
  assert.equal(validDiagramPng(corrupt), false);
  assert.equal(validDiagramPng(bytes.subarray(0, bytes.length - 1)), false);
  assert.equal(validDiagramPng(Buffer.concat([bytes, Buffer.from([0])])), false);
  const badPixels = Buffer.concat([
    bytes.subarray(0, 33),
    chunk("IDAT", deflateSync(Buffer.from([9, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.equal(validDiagramPng(badPixels), false);
});
