// Generates web/og.png — the 1200×630 social/share card.
// Zero dependencies: raw PNG chunks over node:zlib, text from a 5×7 bitmap
// font scaled up. Palette mirrors web/styles.css. Rerun after changing copy:
//   node src/tools/og-image.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200, H = 630;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "og.png");

// ---- palette (styles.css) ---------------------------------------------------
const BG = [0x08, 0x0b, 0x0f];
const GRID = [0x0e, 0x15, 0x1b];
const LINE = [0x22, 0x30, 0x3a];
const TEXT = [0xf0, 0xf6, 0xfa];
const DIM = [0x8f, 0xa2, 0xae];
const ACCENT = [0xf2, 0xab, 0x42];
const SIGNAL = [0x45, 0xd3, 0xe0];
const OK = [0x55, 0xd6, 0x85];

// ---- framebuffer ------------------------------------------------------------
const px = new Uint8Array(W * H * 3);
function set(x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
}
function rect(x, y, w, h, c) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c);
}
function ring(cx, cy, r, thick, c) {
  const lo = (r - thick) ** 2, hi = r ** 2;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d >= lo && d <= hi) set(x, y, c);
  }
}
function disc(cx, cy, r, c) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, c);
}

// ---- 5×7 font ---------------------------------------------------------------
const F = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01110","10001","10000","10000","10000","10001","01110"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01110","10001","10000","10111","10001","10001","01110"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"],
  J: ["00111","00010","00010","00010","00010","10010","01100"],
  K: ["10001","10010","10100","11000","10100","10010","10001"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","11011","10001"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"],
  Z: ["11111","00001","00010","00100","01000","10000","11111"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  ",": ["00000","00000","00000","00000","01100","01100","01000"],
  "-": ["00000","00000","00000","01110","00000","00000","00000"],
  "·": ["00000","00000","01100","01100","00000","00000","00000"],
};

function textWidth(s, scale, sp) { return s.length * (5 * scale + sp) - sp; }
function draw(s, x, y, scale, c, sp = Math.max(2, scale)) {
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const g = F[ch] || F[" "];
    for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++)
      if (g[r][col] === "1") rect(cx + col * scale, y + r * scale, scale, scale, c);
    cx += 5 * scale + sp;
  }
}
function centre(s, y, scale, c, sp = Math.max(2, scale)) {
  draw(s, Math.round((W - textWidth(s, scale, sp)) / 2), y, scale, c, sp);
}

// ---- compose ----------------------------------------------------------------
rect(0, 0, W, H, BG);

// faint plotting grid
for (let x = 0; x < W; x += 60) rect(x, 0, 1, H, GRID);
for (let y = 0; y < H; y += 60) rect(0, y, W, 1, GRID);

// targeting reticle behind the title
ring(600, 300, 250, 2, LINE);
ring(600, 300, 180, 1, GRID);
rect(600 - 270, 299, 34, 2, LINE); rect(600 + 236, 299, 34, 2, LINE);
rect(599, 300 - 270, 2, 34, LINE); rect(599, 300 + 236, 2, 34, LINE);

// corner brackets, surveillance-style
const B = 34, T2 = 4, M = 28;
rect(M, M, B, T2, ACCENT); rect(M, M, T2, B, ACCENT);
rect(W - M - B, M, B, T2, ACCENT); rect(W - M - T2, M, T2, B, ACCENT);
rect(M, H - M - T2, B, T2, ACCENT); rect(M, H - M - B, T2, B, ACCENT);
rect(W - M - B, H - M - T2, B, T2, ACCENT); rect(W - M - T2, H - M - B, T2, B, ACCENT);

// top-left: live marker · top-right: locale
disc(92, 102, 7, OK);
draw("LIVE", 112, 92, 3, OK);
draw("BALLARD · SEATTLE", W - 80 - textWidth("BALLARD · SEATTLE", 3, 3), 92, 3, DIM, 3);

// title — JIMOTHY bright, TRACKER dim, like the site brand
{
  const scale = 12, sp = 10;
  const w = textWidth("JIMOTHY", scale, sp) + sp + textWidth("TRACKER", scale, sp);
  const x = Math.round((W - w) / 2);
  draw("JIMOTHY", x, 198, scale, TEXT, sp);
  draw("TRACKER", x + textWidth("JIMOTHY", scale, sp) + sp, 198, scale, DIM, sp);
}

// tagline
centre("LIVE INTELLIGENCE ON A RACCOON", 330, 5, TEXT, 4);
centre("NOBODY CAN FIND", 380, 5, ACCENT, 4);

// domain
centre("JIMOTHYTRACKER.XYZ", 538, 5, SIGNAL, 4);

// scanlines: darken every 3rd row 12%
for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  px[i] = (px[i] * 224) >> 8; px[i + 1] = (px[i + 1] * 224) >> 8; px[i + 2] = (px[i + 2] * 224) >> 8;
}

// ---- encode PNG -------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

const scan = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  scan[y * (W * 3 + 1)] = 0; // filter: none
  px.subarray(y * W * 3, (y + 1) * W * 3).forEach((v, i) => { scan[y * (W * 3 + 1) + 1 + i] = v; });
}

writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(scan, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`[og-image] wrote ${OUT}`);
