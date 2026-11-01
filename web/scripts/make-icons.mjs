/**
 * PLACEHOLDER ICON GENERATOR (no dependencies)
 * The repo had no logo/icon assets, so this draws a simple placeholder mark:
 * an envelope with an eighth note, deep green on cream. It writes:
 *   web/public/icons/icon-192.png, icon-512.png, maskable-512.png
 *   web/public/apple-touch-icon.png (180), favicon-32.png, favicon.svg
 *   web/public/splash/*.png (iPad launch screens)
 *   android/app/src/main/res/mipmap-* (launcher + adaptive foreground), if the Android project exists
 * Replace with real artwork later (see ASSETS-NEEDED.md) and re-run: npm run icons -w web
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const repo = path.resolve(web, "..");
const GREEN = [47, 93, 80], CREAM = [244, 239, 230], GOLD = [201, 162, 39], WHITE = [255, 253, 248];

// ---------- PNG encoder ----------
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- shapes (coordinates in 0..1 of the mark box) ----------
const roundRect = (x, y, x0, y0, x1, y1, r) => { const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r)); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1; };
const distSeg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };
/** Colour of the mark at (x,y) in 0..1, or null for background. */
function mark(x, y) {
  // envelope body
  const ex0 = 0.18, ey0 = 0.30, ex1 = 0.82, ey1 = 0.72, stroke = 0.045;
  const inEnv = roundRect(x, y, ex0, ey0, ex1, ey1, 0.05);
  const inInner = roundRect(x, y, ex0 + stroke, ey0 + stroke, ex1 - stroke, ey1 - stroke, 0.02);
  const flap = Math.min(distSeg(x, y, ex0 + 0.03, ey0 + 0.04, 0.5, 0.53), distSeg(x, y, 0.5, 0.53, ex1 - 0.03, ey0 + 0.04)) < stroke / 2;
  // eighth note (gold) overlapping the top-right corner
  const head = ((x - 0.70) / 0.075) ** 2 + ((y - 0.30) / 0.055) ** 2 <= 1;
  const stemX = 0.765, stem = x >= stemX - 0.018 && x <= stemX + 0.018 && y >= 0.10 && y <= 0.30;
  const flagD = distSeg(x, y, stemX, 0.11, 0.86, 0.20) < 0.022;
  if (head || stem || flagD) return GOLD;
  if (inEnv && (!inInner || flap)) return WHITE;
  return null;
}

function render(size, { bg = GREEN, radius = 0.22, scale = 1, transparentOutside = true, ss = 3 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (px + (sx + 0.5) / ss) / size, v = (py + (sy + 0.5) / ss) / size;
      const inBg = radius > 0 ? roundRect(u, v, 0, 0, 1, 1, radius) : true;
      if (!inBg && transparentOutside) continue;
      const mu = (u - 0.5) / scale + 0.5, mv = (v - 0.5) / scale + 0.5;
      const c = bg && inBg ? (mark(mu, mv) ?? bg) : mark(mu, mv);
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; a += 255;
    }
    const n = ss * ss, i = (py * size + px) * 4;
    const cov = a / 255;
    buf[i] = cov ? r / cov : 0; buf[i + 1] = cov ? g / cov : 0; buf[i + 2] = cov ? b / cov : 0; buf[i + 3] = a / n;
  }
  return buf;
}
function write(file, size, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(size, size, render(size, opts)));
  console.log("wrote", path.relative(repo, file));
}
function splash(file, w, h) {
  const icon = 360, ic = render(icon, { radius: 0.22 });
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = CREAM[0]; buf[i * 4 + 1] = CREAM[1]; buf[i * 4 + 2] = CREAM[2]; buf[i * 4 + 3] = 255; }
  const ox = Math.floor((w - icon) / 2), oy = Math.floor((h - icon) / 2);
  for (let y = 0; y < icon; y++) for (let x = 0; x < icon; x++) {
    const s = (y * icon + x) * 4, d = ((oy + y) * w + ox + x) * 4, al = ic[s + 3] / 255;
    for (let k = 0; k < 3; k++) buf[d + k] = Math.round(ic[s + k] * al + buf[d + k] * (1 - al));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(w, h, buf));
  console.log("wrote", path.relative(repo, file));
}

const pub = path.join(web, "public");
write(path.join(pub, "icons/icon-192.png"), 192);
write(path.join(pub, "icons/icon-512.png"), 512);
write(path.join(pub, "icons/maskable-512.png"), 512, { radius: 0, scale: 0.78 });     // full bleed, mark in safe zone
write(path.join(pub, "apple-touch-icon.png"), 180, { radius: 0, scale: 0.9 });         // iOS adds its own rounding
write(path.join(pub, "favicon-32.png"), 32, { ss: 4 });
fs.writeFileSync(path.join(pub, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f5d50"/><rect x="18" y="30" width="64" height="42" rx="5" fill="none" stroke="#fffdf8" stroke-width="4.5"/><path d="M21 34 L50 53 L79 34" fill="none" stroke="#fffdf8" stroke-width="4.5" stroke-linecap="round"/><ellipse cx="70" cy="30" rx="7.5" ry="5.5" fill="#c9a227"/><rect x="74.7" y="10" width="3.6" height="20" fill="#c9a227"/><path d="M76.5 11 L86 20" stroke="#c9a227" stroke-width="4.4" stroke-linecap="round"/></svg>\n`);

for (const [name, w, h] of [["ipad-pro-12.9", 2048, 2732], ["ipad-pro-11", 1668, 2388], ["ipad-air", 1640, 2360], ["ipad-10.2", 1620, 2160], ["ipad-mini", 1488, 2266]]) {
  splash(path.join(pub, `splash/${name}-portrait.png`), w, h);
  splash(path.join(pub, `splash/${name}-landscape.png`), h, w);
}

const res = path.join(repo, "android/app/src/main/res");
if (fs.existsSync(res)) {
  for (const [d, s] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]]) {
    write(path.join(res, `mipmap-${d}/ic_launcher.png`), s);
    write(path.join(res, `mipmap-${d}/ic_launcher_round.png`), s, { radius: 0.5 });
    write(path.join(res, `mipmap-${d}/ic_launcher_foreground.png`), Math.round(s * 2.25), { bg: null, radius: 0, scale: 0.62 });
  }
  fs.mkdirSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
  fs.writeFileSync(path.join(res, "mipmap-anydpi-v26/ic_launcher.xml"), adaptive);
  fs.writeFileSync(path.join(res, "mipmap-anydpi-v26/ic_launcher_round.xml"), adaptive);
  fs.mkdirSync(path.join(res, "values"), { recursive: true });
  fs.writeFileSync(path.join(res, "values/ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2F5D50</color>\n</resources>\n`);
  console.log("wrote Android adaptive icon set");
}
