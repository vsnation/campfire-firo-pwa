// The app icons (src/icons/, made by tools/make_icons.mjs) are the logo on its navy, at the size the
// manifest and index.html name: never a blank or a broken-image square (release audit of 0.1.25: a
// render that could not load the logo wrote four white PNGs with the browser's broken-image glyph).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** A PNG's pixels (8-bit RGB or RGBA, not interlaced): {width, height, rgb(i) -> [r, g, b]}. */
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG');
  let o = 8;
  let width, height, depth, type, interlace;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') ({ 0: width, 1: height } = [data.readUInt32BE(0), data.readUInt32BE(4)]), (depth = data[8]), (type = data[9]), (interlace = data[12]);
    else if (kind === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  assert.equal(depth, 8);
  assert.equal(interlace, 0);
  const bpp = type === 6 ? 4 : type === 2 ? 3 : assert.fail(`colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (cur + pred) & 0xff;
    }
  }
  return { width, height, rgb: (i) => [out[i * bpp], out[i * bpp + 1], out[i * bpp + 2]] };
}

const ICONS = [
  ['firo-pwa-192.png', 192],
  ['firo-pwa-512.png', 512],
  ['firo-pwa-maskable-512.png', 512],
  ['firo-pwa-apple-180.png', 180],
  ['icon-192.png', 192], // the notifications' (lib/notify.js, the service worker)
];

test('every app icon is the logo on navy at its named size: not a blank or broken-image square', () => {
  const manifest = readFileSync(join(SRC, 'manifest.webmanifest'), 'utf8');
  const index = readFileSync(join(SRC, 'index.html'), 'utf8');
  for (const [file, size] of ICONS) {
    assert.ok(manifest.includes(`icons/${file}`) || index.includes(`icons/${file}`) || file === 'icon-192.png', `${file} is named`);
    const png = decodePng(readFileSync(join(SRC, 'icons', file)));
    assert.equal(png.width, size, file);
    assert.equal(png.height, size, file);
    let white = 0;
    let navy = 0;
    let coral = 0;
    const n = size * size;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = png.rgb(i);
      if (r > 240 && g > 240 && b > 240) white++;
      if (r < 60 && g < 70 && b > 50 && b < 100) navy++;
      if (r > 200 && g < 130 && b < 150) coral++;
    }
    assert.ok(white / n < 0.02, `${file}: ${Math.round((100 * white) / n)}% white`);
    assert.ok(navy / n > 0.6, `${file}: the navy background (${Math.round((100 * navy) / n)}%)`);
    assert.ok(coral / n > 0.08, `${file}: the coral logo (${Math.round((100 * coral) / n)}%)`);
  }
});
