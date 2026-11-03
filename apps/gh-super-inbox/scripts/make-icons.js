// Writes icons/icon{16,48,128}.png: a purple rounded square with a white check.
// No dependencies, so the icons can be regenerated with plain `node`.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const r = size * 0.22;
  const stroke = size * 0.065;
  const check = [[0.28, 0.53], [0.44, 0.69], [0.74, 0.36]].map(([x, y]) => [x * size, y * size]);
  const ss = 4; // supersampling per axis
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          const cx = Math.min(Math.max(px, r), size - r), cy = Math.min(Math.max(py, r), size - r);
          if (Math.hypot(px - cx, py - cy) <= r) {
            bg++;
            const d = Math.min(
              distToSegment(px, py, ...check[0], ...check[1]),
              distToSegment(px, py, ...check[1], ...check[2])
            );
            if (d <= stroke) fg++;
          }
        }
      }
      const a = bg / (ss * ss), w = fg / (ss * ss);
      const mix = (purple) => Math.round(purple + (255 - purple) * (bg ? w / a : 0));
      const o = 1 + x * 4;
      row[o] = mix(0x82); row[o + 1] = mix(0x50); row[o + 2] = mix(0xdf); row[o + 3] = Math.round(a * 255);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), render(size));
}
console.log('wrote icons to', outDir);
