/*
 * Generates icons/icon{16,32,48,128}.png with no dependencies.
 * Run: node tools/gen-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size) {
  const SS = 4; // supersampling
  const N = size * SS;
  const out = Buffer.alloc(size * size * 4);

  // red lock body with a white play button inside
  const bodyX0 = 0.21 * N, bodyX1 = 0.79 * N;
  const bodyY0 = 0.44 * N, bodyY1 = 0.90 * N;
  const bodyR = 0.085 * N;

  // shackle (padlock arc)
  const ringCX = 0.5 * N, ringCY = 0.47 * N;
  const ringOuter = 0.245 * N, ringInner = 0.177 * N;

  // play triangle
  const ax = 0.435 * N, ay = 0.565 * N;
  const bx = 0.435 * N, by = 0.745 * N;
  const cx = 0.575 * N, cy = 0.655 * N;

  const red = [229, 43, 36];   // #e52b24
  const dark = [162, 13, 9];   // #a20d09 shackle
  const edgeMix = 0.022 * N;   // darker band around the body edge
  const fg = [255, 255, 255];

  function inBody(x, y) {
    const dx = Math.max(bodyX0 + bodyR - x, 0, x - (bodyX1 - bodyR));
    const dy = Math.max(bodyY0 + bodyR - y, 0, y - (bodyY1 - bodyR));
    return dx * dx + dy * dy <= bodyR * bodyR;
  }

  function bodyEdgeDistance(x, y) {
    const hw = (bodyX1 - bodyX0) / 2;
    const hh = (bodyY1 - bodyY0) / 2;
    const dx = Math.max(Math.abs(x - (bodyX0 + bodyX1) / 2) - (hw - bodyR), 0);
    const dy = Math.max(Math.abs(y - (bodyY0 + bodyY1) / 2) - (hh - bodyR), 0);
    return Math.hypot(dx, dy) - bodyR;
  }

  function inRing(x, y) {
    const d = Math.hypot(x - ringCX, y - ringCY);
    return d >= ringInner && d <= ringOuter && y <= bodyY0;
  }

  function inTriangle(x, y) {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bodyHits = 0;
      let ringHits = 0;
      let fgHits = 0;
      let depth = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          const isBody = inBody(px, py);
          const isRing = !isBody && inRing(px, py);
          if (isBody) {
            bodyHits += 1;
            depth += bodyEdgeDistance(px, py) > -edgeMix ? 1 : 0;
            if (inTriangle(px, py)) fgHits += 1;
          } else if (isRing) {
            ringHits += 1;
          }
        }
      }
      const total = SS * SS;
      const alpha = (bodyHits + ringHits) / total;
      const idx = (y * size + x) * 4;
      if (alpha === 0) {
        out[idx + 3] = 0;
        continue;
      }
      const mix = [0, 0, 0];
      if (bodyHits) {
        const t = fgHits / bodyHits; // white triangle coverage inside body
        const shaded = depth / bodyHits; // dark edge band coverage
        for (let c = 0; c < 3; c += 1) {
          const base = red[c] * (1 - shaded) + dark[c] * shaded;
          mix[c] += (base * (1 - t) + fg[c] * t) * (bodyHits / total);
        }
      }
      if (ringHits) {
        for (let c = 0; c < 3; c += 1) {
          mix[c] += dark[c] * (ringHits / total);
        }
      }
      out[idx] = Math.round(mix[0]);
      out[idx + 1] = Math.round(mix[1]);
      out[idx + 2] = Math.round(mix[2]);
      out[idx + 3] = Math.round(alpha * 255);
    }
  }

  return out;
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png — ${png.length} bytes`);
}
