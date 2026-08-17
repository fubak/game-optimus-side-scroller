/**
 * Minimal PNG encoder for straight RGBA8 buffers.
 *
 * No image-writing package is a dependency of this project (deliberately — see
 * `scripts/generateMaterials.ts`), so this hand-rolls the PNG container: signature, `IHDR`,
 * one `IDAT` chunk of filter-0 (none) scanlines, `IEND`, and the CRC-32 each chunk requires. The
 * only non-trivial piece of the format — DEFLATE compression — is delegated to Node's built-in
 * `zlib`, which is not a project dependency, just the standard library.
 */

import { deflateSync } from 'node:zlib';

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[tableIndex] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 0);
  return Buffer.concat([length, typeBytes, body, crc]);
}

/** Encode a straight (non-premultiplied) RGBA8 buffer of `width * height * 4` bytes as a PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${String(expected)} bytes for ${String(width)}x${String(height)}, got ${String(rgba.length)}.`);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // per-scanline filter byte: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const idat = pngChunk('IDAT', deflateSync(raw, { level: 9 }));

  const iend = pngChunk('IEND', new Uint8Array(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}
