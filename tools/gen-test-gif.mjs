// Generates test/animated.gif: a small looping GIF89a where a slate block slides
// left-to-right across 4 frames. Used by test/harness.html to verify Steady
// freezes animated GIFs to their first frame. No native dependencies.
//
// Uses the well-known "uncompressed LZW" technique: a fixed code size with a
// clear code emitted before the decoder's dictionary would overflow. Simple and
// spec-correct. Palette depth is 7 bits (128 entries) so the LZW minimum code
// size matches the palette for maximum decoder compatibility.
//
// Usage: node tools/gen-test-gif.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'test', 'animated.gif');

const W = 48, H = 48, FRAMES = 4, DELAY = 25; // delay in 1/100s
const MIN_CODE_SIZE = 7; // 128-entry palette

// 128-entry palette; only 0 and 1 are used.
const palette = new Uint8Array(128 * 3);
palette[0] = 238; palette[1] = 242; palette[2] = 245; // index 0: off-white
palette[3] = 90;  palette[4] = 106; palette[5] = 120; // index 1: slate

function frameIndices(i) {
  const px = new Uint8Array(W * H);
  const blockW = Math.floor(W / FRAMES);
  const startX = i * blockW;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      px[y * W + x] = (x >= startX && x < startX + blockW) ? 1 : 0;
    }
  }
  return px;
}

function lzwUncompressed(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const codeSize = minCodeSize + 1;
  const maxCode = (1 << codeSize) - 1; // 255
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
    if (next >= maxCode) { // reset before the decoder needs a wider code
      emit(clearCode);
      next = endCode + 1;
    }
  }
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

function subBlocks(bytes) {
  // GIF image data is a series of sub-blocks, each <= 255 bytes, length-prefixed,
  // terminated by a zero-length block.
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

// Header
push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
// Logical Screen Descriptor
u16(W); u16(H);
push(0xf6, 0x00, 0x00); // GCT present, 7-bit color res, 128-entry table; bg 0; aspect 0
// Global Color Table
push(...palette);
// Netscape looping extension (loop forever)
push(0x21, 0xff, 0x0b);
push(...Buffer.from('NETSCAPE2.0', 'ascii'));
push(0x03, 0x01, 0x00, 0x00, 0x00);

for (let f = 0; f < FRAMES; f++) {
  // Graphic Control Extension
  push(0x21, 0xf9, 0x04, 0x04); // disposal = do-not-dispose, no transparency
  u16(DELAY);
  push(0x00, 0x00);
  // Image Descriptor
  push(0x2c);
  u16(0); u16(0); u16(W); u16(H);
  push(0x00); // no local color table
  // Image data
  push(MIN_CODE_SIZE);
  push(...subBlocks(lzwUncompressed(MIN_CODE_SIZE, frameIndices(f))));
}

push(0x3b); // trailer

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(bytes));
console.log(`wrote ${OUT} (${bytes.length} bytes), ${FRAMES} frames`);
