// Generates the onboarding live-proof pair:
//   assets/onboarding.gif        a steady-blue dot swinging like a pendulum
//                                bob, 8 frames, seamless loop
//   assets/onboarding-still.png  frame one as a static PNG
//
// The onboarding page shows the PNG while Steady is on and swaps in the GIF
// when the user flips the master switch off. A pre-rendered first frame is
// exactly what Steady produces on real sites (it replaces a GIF's src with a
// first-frame PNG), and shipping it as an asset means the proof can never
// race image decoding. Same dependency-free encoders as the other tools.
//
// Usage: node tools/gen-onboarding-gif.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'onboarding.gif');
const OUT_STILL = join(__dirname, '..', 'assets', 'onboarding-still.png');

const W = 120, H = 72, FRAMES = 8, DELAY = 7; // delay in 1/100s
const MIN_CODE_SIZE = 7;

// 128-entry palette; index 0 paper, 1 steady blue, 2 soft slate (shadow line).
const palette = new Uint8Array(128 * 3);
palette[0] = 238; palette[1] = 242; palette[2] = 245; // #eef2f5
palette[3] = 58;  palette[4] = 110; palette[5] = 165; // #3a6ea5
palette[6] = 211; palette[7] = 218; palette[8] = 224; // #d3dae0

function frameIndices(i) {
  const px = new Uint8Array(W * H);
  const phase = (2 * Math.PI * i) / FRAMES;
  const cx = 60 + 40 * Math.sin(phase);
  const cy = 30 + 8 * Math.sin(2 * phase);
  const r = 9;
  const lineY = 56; // the steady horizon under the swinging dot
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      if (y === lineY || y === lineY + 1) v = 2;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) v = 1;
      px[y * W + x] = v;
    }
  }
  return px;
}

function lzwUncompressed(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const codeSize = minCodeSize + 1;
  const maxCode = (1 << codeSize) - 1;
  const out = [];
  let bitBuffer = 0, bitCount = 0;
  function emit(code) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }
  let next = endCode + 1;
  emit(clearCode);
  for (let i = 0; i < indices.length; i++) {
    emit(indices[i]);
    next++;
    if (next >= maxCode) {
      emit(clearCode);
      next = endCode + 1;
    }
  }
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const bytes = [];
const push = (...b) => bytes.push(...b);
const u16 = (n) => push(n & 0xff, (n >> 8) & 0xff);

push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
u16(W); u16(H);
push(0xf6, 0x00, 0x00);
push(...palette);
push(0x21, 0xff, 0x0b);
push(...Buffer.from('NETSCAPE2.0', 'ascii'));
push(0x03, 0x01, 0x00, 0x00, 0x00); // loop forever

for (let f = 0; f < FRAMES; f++) {
  push(0x21, 0xf9, 0x04, 0x04);
  u16(DELAY);
  push(0x00, 0x00);
  push(0x2c);
  u16(0); u16(0); u16(W); u16(H);
  push(0x00);
  push(MIN_CODE_SIZE);
  push(...subBlocks(lzwUncompressed(MIN_CODE_SIZE, frameIndices(f))));
}

push(0x3b);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(bytes));
console.log(`wrote ${OUT} (${bytes.length} bytes), ${FRAMES} frames`);

// ---- frame one as a static PNG ----------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const frame0 = frameIndices(0);
const raw = Buffer.alloc((W * 4 + 1) * H);
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const idx = frame0[y * W + x] * 3;
    raw[p++] = palette[idx];
    raw[p++] = palette[idx + 1];
    raw[p++] = palette[idx + 2];
    raw[p++] = 255;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(OUT_STILL, png);
console.log(`wrote ${OUT_STILL} (${png.length} bytes)`);
