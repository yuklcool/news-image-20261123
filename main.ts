import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);
const VALID_PNG_BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);

interface PngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  chunkCount: number;
  byteLength: number;
}

const ENTRY_MAX_BYTES = 1_048_576;
const EXPECTED_SIDE = 1024;
const MAGIC_HEADER = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function buildCrcLookup(): Uint32Array {
  const lookup = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    let reg = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      reg = reg & 1 ? 0xedb88320 ^ (reg >>> 1) : reg >>> 1;
    }
    lookup[byte] = reg >>> 0;
  }
  return lookup;
}

const CRC_LOOKUP = buildCrcLookup();

function crc32Bytes(slice: Uint8Array): number {
  let state = 0xffffffff;
  for (let idx = 0; idx < slice.length; idx += 1) {
    state = CRC_LOOKUP[(state ^ slice[idx]) & 0xff] ^ (state >>> 8);
  }
  return (state ^ 0xffffffff) >>> 0;
}

function hasValidMagic(raw: Buffer): boolean {
  if (raw.length < MAGIC_HEADER.length) return false;
  for (let i = 0; i < MAGIC_HEADER.length; i += 1) {
    if (raw[i] !== MAGIC_HEADER[i]) return false;
  }
  return true;
}

function inspectPngPayload(raw: Buffer): PngMetadata {
  if (raw.length === 0 || raw.length > ENTRY_MAX_BYTES) {
    throw new Error(`PNG size ${raw.length} outside allowed range 1..${ENTRY_MAX_BYTES}`);
  }
  if (!hasValidMagic(raw)) {
    throw new Error("Source artifact lacks a valid 8-byte PNG signature");
  }

  let cursor = MAGIC_HEADER.length;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let hasIdat = false;
  let terminated = false;

  while (cursor + 12 <= raw.length) {
    const dataLen = raw.readUInt32BE(cursor);
    const kind = raw.toString("ascii", cursor + 4, cursor + 8);
    const nextCursor = cursor + 12 + dataLen;
    if (nextCursor > raw.length) {
      throw new Error(`PNG chunk ${kind} truncated past end of buffer`);
    }

    const storedCrc = raw.readUInt32BE(nextCursor - 4);
    const calcCrc = crc32Bytes(raw.subarray(cursor + 4, nextCursor - 4));
    if (storedCrc !== calcCrc) {
      throw new Error(`Checksum failure in PNG chunk ${kind} at byte ${cursor}`);
    }

    if (chunkCount === 0) {
      if (kind !== "IHDR" || dataLen !== 13) {
        throw new Error(`First PNG chunk must be 13-byte IHDR, got ${kind} (${dataLen})`);
      }
      width = raw.readUInt32BE(cursor + 8);
      height = raw.readUInt32BE(cursor + 12);
      bitDepth = raw[cursor + 16];
      colorType = raw[cursor + 17];
      const compression = raw[cursor + 18];
      const filterMethod = raw[cursor + 19];
      if (compression !== 0 || filterMethod !== 0) {
        throw new Error(`Unsupported PNG compression/filter (${compression}/${filterMethod})`);
      }
    }

    if (kind === "IDAT") hasIdat = true;
    chunkCount += 1;
    cursor = nextCursor;

    if (kind === "IEND") {
      if (dataLen !== 0) throw new Error("PNG IEND chunk must have zero payload bytes");
      terminated = true;
      break;
    }
  }

  if (!terminated || !hasIdat || cursor !== raw.length) {
    throw new Error("PNG payload is incomplete or has trailing bytes after IEND");
  }
  if (width !== EXPECTED_SIDE || height !== EXPECTED_SIDE) {
    throw new Error(`Expected ${EXPECTED_SIDE}x${EXPECTED_SIDE} PNG, got ${width}x${height}`);
  }
  if (!VALID_PNG_COLOR_TYPES.has(colorType) || !VALID_PNG_BIT_DEPTHS.has(bitDepth)) {
    throw new Error(`Invalid PNG colorType=${colorType} or bitDepth=${bitDepth}`);
  }

  return { width, height, bitDepth, colorType, chunkCount, byteLength: raw.length };
}

function sha256Hex(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function run(): void {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const inputPath = resolve(repoRoot, "entry.png");
  const outRoot = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
  const outPath = join(outRoot, "entry.png");

  const imageBytes = readFileSync(inputPath);
  inspectPngPayload(imageBytes);
  const expectedDigest = sha256Hex(imageBytes);

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(outPath, imageBytes);

  const writtenDigest = sha256Hex(readFileSync(outPath));
  if (writtenDigest !== expectedDigest) {
    throw new Error("Written entry.png digest does not match verified source artifact");
  }
}

run();
