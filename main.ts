import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PNG_LIMIT_BYTES = 1024 * 1024;
const REQUIRED_PX = 1024;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

const ALLOWED_DEPTHS_BY_COLOR: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

interface AuditedPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly totalChunks: number;
  readonly idatChunks: number;
  readonly idatBytes: number;
  readonly sha256: string;
}

class PngAudit {
  private static readonly crcTable: Uint32Array = PngAudit.makeCrcTable();

  private static makeCrcTable(): Uint32Array {
    const tbl = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let val = n;
      for (let step = 0; step < 8; step += 1) {
        val = (val & 1) === 1 ? 0xedb88320 ^ (val >>> 1) : val >>> 1;
      }
      tbl[n] = val >>> 0;
    }
    return tbl;
  }

  private static checksum(segment: Uint8Array): number {
    let acc = 0xffffffff;
    const table = PngAudit.crcTable;
    for (let i = 0; i < segment.length; i += 1) {
      acc = table[(acc ^ segment[i]) & 0xff] ^ (acc >>> 8);
    }
    return (acc ^ 0xffffffff) >>> 0;
  }

  public static validate(buf: Buffer): AuditedPng {
    if (buf.byteLength === 0 || buf.byteLength > PNG_LIMIT_BYTES) {
      throw new Error(`Artifact byte length ${buf.byteLength} violates 1..${PNG_LIMIT_BYTES} limit`);
    }
    if (buf.byteLength < PNG_MAGIC.byteLength || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new Error("Artifact does not start with an ISO PNG magic signature");
    }

    let pos = PNG_MAGIC.byteLength;
    let totalChunks = 0;
    let idatChunks = 0;
    let idatBytes = 0;
    let sawPlte = false;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let finished = false;

    while (pos + 12 <= buf.byteLength) {
      const len = buf.readUInt32BE(pos);
      const tag = buf.toString("ascii", pos + 4, pos + 8);
      const end = pos + 12 + len;
      if (end > buf.byteLength) {
        throw new Error(`Chunk ${tag} overflows file boundary at byte ${pos}`);
      }

      const fileCrc = buf.readUInt32BE(end - 4);
      const bodyCrc = PngAudit.checksum(buf.subarray(pos + 4, end - 4));
      if (fileCrc !== bodyCrc) {
        throw new Error(`CRC-32 mismatch inside chunk ${tag} at byte ${pos}`);
      }

      if (totalChunks === 0) {
        if (tag !== "IHDR" || len !== 13) {
          throw new Error(`Expected leading 13-byte IHDR chunk, found ${tag} (${len} bytes)`);
        }
        width = buf.readUInt32BE(pos + 8);
        height = buf.readUInt32BE(pos + 12);
        bitDepth = buf[pos + 16];
        colorType = buf[pos + 17];
        const comp = buf[pos + 18];
        const filt = buf[pos + 19];
        const interlace = buf[pos + 20];
        if (comp !== 0 || filt !== 0 || (interlace !== 0 && interlace !== 1)) {
          throw new Error(`Invalid IHDR flags comp=${comp} filt=${filt} interlace=${interlace}`);
        }
        const allowed = ALLOWED_DEPTHS_BY_COLOR[colorType];
        if (!allowed || !allowed.includes(bitDepth)) {
          throw new Error(`Unsupported PNG colorType=${colorType} with bitDepth=${bitDepth}`);
        }
      } else if (tag === "IHDR") {
        throw new Error("Duplicate IHDR chunk detected");
      }

      if (tag === "PLTE") sawPlte = true;
      if (tag === "IDAT") {
        idatChunks += 1;
        idatBytes += len;
      }
      totalChunks += 1;
      pos = end;

      if (tag === "IEND") {
        if (len !== 0) {
          throw new Error(`IEND chunk must be empty, got ${len} bytes`);
        }
        finished = true;
        break;
      }
    }

    if (!finished || idatChunks === 0 || idatBytes === 0 || pos !== buf.byteLength) {
      throw new Error("Incomplete PNG chunk stream or trailing bytes present after IEND");
    }
    if (colorType === 3 && !sawPlte) {
      throw new Error("Indexed-color PNG is missing required PLTE palette chunk");
    }
    if (width !== REQUIRED_PX || height !== REQUIRED_PX) {
      throw new Error(`PNG dimensions ${width}x${height} do not match required ${REQUIRED_PX}x${REQUIRED_PX}`);
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { width, height, bitDepth, colorType, totalChunks, idatChunks, idatBytes, sha256 };
  }
}

function ensureDeterministicWrite(destination: string, expected: Buffer, expectedHash: string): void {
  writeFileSync(destination, expected);
  const emitted = readFileSync(destination);
  if (!emitted.equals(expected)) {
    throw new Error("Emitted output bytes differ from validated source artifact");
  }
  const verifyHash = createHash("sha256").update(emitted).digest("hex");
  if (verifyHash !== expectedHash) {
    throw new Error("Post-write SHA-256 verification failed");
  }
}

function writeVerifiedArtifact(): void {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const sourceFile = resolve(baseDir, "entry.png");
  const targetDir = resolve(process.env.MAKEFUN_OUTPUT_DIR || "/output");
  const targetFile = join(targetDir, "entry.png");

  const payload = readFileSync(sourceFile);
  const audit = PngAudit.validate(payload);

  mkdirSync(targetDir, { recursive: true });
  ensureDeterministicWrite(targetFile, payload, audit.sha256);
}

writeVerifiedArtifact();
