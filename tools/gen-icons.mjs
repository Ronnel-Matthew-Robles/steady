// Generates Steady's calm, minimal icons with no native dependencies.
//
// Design: a soft rounded-square slate background (gentle vertical gradient) with
// a centered off-white "steady horizon" pill. No red, no alarm. Edges are
// anti-aliased by 4x4 supersampling. PNGs are encoded by hand via zlib.
//
// Usage: node tools/gen-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'icons');

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[p++] = rgba[i];
      raw[p++] = rgba[i + 1];
      raw[p++] = rgba[i + 2];
      raw[p++] = rgba[i + 3];
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Rendering -------------------------------------------------------------

// Signed distance to an axis-aligned rounded rectangle (<= 0 means inside).
function roundedRectSDF(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function renderRGBA(size) {
  const SS = 4; // supersampling per axis
  const rgba = new Uint8ClampedArray(size * size * 4);

  const bgR = roundedRectSDF; // alias
  const bgRadius = size * 0.22;
  const barHW = size * 0.32;
  const barHH = Math.max(size * 0.06, 0.75);
  const barRadius = barHH;
  const c = size / 2;

  // gradient endpoints (slate)
  const top = [59, 74, 90];
  const bot = [82, 96, 110];
  const bar = [238, 242, 245];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sumA = 0, accR = 0, accG = 0, accB = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const inBg = bgR(px, py, c, c, c, c, bgRadius) <= 0;
          if (!inBg) continue;
          const t = py / size;
          let r = lerp(top[0], bot[0], t);
          let g = lerp(top[1], bot[1], t);
          let b = lerp(top[2], bot[2], t);
          if (roundedRectSDF(px, py, c, c, barHW, barHH, barRadius) <= 0) {
            r = bar[0]; g = bar[1]; b = bar[2];
          }
          sumA += 1;
          accR += r; accG += g; accB += b;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (sumA === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(accR / sumA);
        rgba[i + 1] = Math.round(accG / sumA);
        rgba[i + 2] = Math.round(accB / sumA);
        rgba[i + 3] = Math.round((sumA / n) * 255);
      }
    }
  }
  return rgba;
}

// ---- Main ------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const png = encodePng(size, size, renderRGBA(size));
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
console.log('done');
