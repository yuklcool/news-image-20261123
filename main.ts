import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1024 * 1024;
const MAX_DIMENSION = 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_IMAGE = resolve(CURRENT_DIR, "entry.png");
const OUTPUT_DIR = resolve(process.env.MAKEFUN_OUTPUT_DIR || "/output");
const DEST_IMAGE = join(OUTPUT_DIR, "entry.png");

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
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Invalid entry.png dimensions: ${width}x${height}`);
  }
  if (!payload.subarray(payload.length - PNG_IEND.length).equals(PNG_IEND)) {
    throw new Error("entry.png does not end with a complete IEND chunk");
  }
}

function emitEntry(): void {
  const bytes = readFileSync(SOURCE_IMAGE);
  verifyPngBuffer(bytes);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(DEST_IMAGE, bytes);
}

emitEntry();
