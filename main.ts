import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1024 * 1024;
const TARGET_DIMENSION = 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_IMAGE = resolve(CURRENT_DIR, "entry.png");
const OUTPUT_DIR = resolve(process.env.MAKEFUN_OUTPUT_DIR || "/output");
const DEST_IMAGE = join(OUTPUT_DIR, "entry.png");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyPngChunks(payload: Buffer): void {
  let offset = PNG_SIGNATURE.length;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (offset + 12 <= payload.length) {
    const length = payload.readUInt32BE(offset);
    const type = payload.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > payload.length) {
      throw new Error(`Truncated PNG chunk ${type} at offset ${offset}`);
    }
    const expectedCrc = payload.readUInt32BE(chunkEnd - 4);
    const actualCrc = computeCrc32(payload.subarray(offset + 4, chunkEnd - 4));
    if (expectedCrc !== actualCrc) {
      throw new Error(`PNG chunk ${type} CRC mismatch at offset ${offset}`);
    }
    if (type === "IHDR") sawIhdr = true;
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      sawIend = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawIhdr || !sawIdat || !sawIend || offset !== payload.length) {
    throw new Error("entry.png does not contain a complete sequence of PNG chunks");
  }
}

function verifyPngBuffer(payload: Buffer): void {
  if (payload.length === 0 || payload.length > MAX_BYTES) {
    throw new Error(`Invalid entry.png size: ${payload.length} bytes (limit ${MAX_BYTES})`);
  }
  if (!payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("entry.png does not begin with a valid PNG signature");
  }
  if (payload.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("entry.png is missing its IHDR header chunk");
  }
  const width = payload.readUInt32BE(16);
  const height = payload.readUInt32BE(20);
  if (width !== TARGET_DIMENSION || height !== TARGET_DIMENSION) {
    throw new Error(`Invalid entry.png dimensions: ${width}x${height} (expected ${TARGET_DIMENSION}x${TARGET_DIMENSION})`);
  }
  if (!payload.subarray(payload.length - PNG_IEND.length).equals(PNG_IEND)) {
    throw new Error("entry.png does not end with a complete IEND chunk");
  }
  verifyPngChunks(payload);
}

function emitEntry(): void {
  const bytes = readFileSync(SOURCE_IMAGE);
  verifyPngBuffer(bytes);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(DEST_IMAGE, bytes);
}

emitEntry();
