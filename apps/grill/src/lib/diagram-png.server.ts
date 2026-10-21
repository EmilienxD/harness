import { inflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate canvas PNG chunk integrity and bounded, noninterlaced 8-bit pixel data. */
export function validDiagramPng(bytes: Buffer): boolean {
  try {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    let ended = false;
    const imageData: Buffer[] = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) return false;
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return false;
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length))
        return false;
      if (offset === 8 && type !== "IHDR") return false;
      if (type === "IHDR") {
        if (offset !== 8 || length !== 13) return false;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        if (
          !width ||
          !height ||
          width > 16384 ||
          height > 16384 ||
          width * height > 16_000_000 ||
          data[8] !== 8 ||
          ![2, 6].includes(data[9]!) ||
          data[10] !== 0 ||
          data[11] !== 0 ||
          data[12] !== 0
        )
          return false;
        channels = data[9] === 6 ? 4 : 3;
      } else if (type === "IDAT") imageData.push(data);
      else if (type === "IEND") {
        if (length || offset + 12 !== bytes.length) return false;
        ended = true;
      } else if (!/^[a-z]/u.test(type) && type !== "PLTE") return false;
      offset += length + 12;
    }
    if (!ended || !imageData.length) return false;
    const rowSize = width * channels + 1;
    const expected = rowSize * height;
    const pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected });
    if (pixels.length !== expected) return false;
    for (let row = 0; row < height; row++) if (pixels[row * rowSize]! > 4) return false;
    return true;
  } catch {
    return false;
  }
}
