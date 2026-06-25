import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

/**
 * Generates Poly (the purple block alien) on a dark rounded square — from the
 * same grid as the TUI/GUI mascot — at two sizes:
 *   - assets/icon.png  (256px) — the runtime window/taskbar icon
 *   - build/icon.png  (1024px) — source for electron-builder's .ico/.icns
 * Dependency-free PNG encoder (zlib only). Run with: node scripts/gen-icon.mjs
 */
const POLY_ART = [
  ".##...........##.",
  "...##.......##...",
  "..#############..",
  "..####OO###OO##..",
  "..#############..",
  "#################",
  "#################",
  "..#############..",
  "....##.....##....",
  "...###.....###...",
];
const COLS = 17;
const ROWS = POLY_ART.length;

const BG = [27, 23, 38, 255]; // #1b1726
const PURPLE = [167, 139, 250, 255]; // #A78BFA

// ---- minimal PNG encode ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};

/** Render Poly at N×N (corner radius R) and return the encoded PNG buffer. */
function render(N, R) {
  const px = Buffer.alloc(N * N * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  };
  const inRounded = (x, y) => {
    const minx = R;
    const maxx = N - 1 - R;
    const miny = R;
    const maxy = N - 1 - R;
    if ((x < minx || x > maxx) && (y < miny || y > maxy)) {
      const cx = x < minx ? minx : maxx;
      const cy = y < miny ? miny : maxy;
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= R * R;
    }
    return true;
  };

  // dark rounded background
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) set(x, y, inRounded(x, y) ? BG : [0, 0, 0, 0]);
  }
  // mascot (eyes/'.' left as background → dark holes)
  const cell = Math.floor((N * 0.82) / COLS);
  const ox = Math.floor((N - cell * COLS) / 2);
  const oy = Math.floor((N - cell * ROWS) / 2);
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      if (POLY_ART[gy][gx] !== "#") continue;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) set(ox + gx * cell + dx, oy + gy * cell + dy, PURPLE);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [dir, name, N, R] of [
  ["assets", "icon.png", 256, 56],
  ["build", "icon.png", 1024, 224],
]) {
  const out = path.join(process.cwd(), dir, name);
  mkdirSync(path.dirname(out), { recursive: true });
  const png = render(N, R);
  writeFileSync(out, png);
  console.log("wrote", out, png.length, "bytes");
}
