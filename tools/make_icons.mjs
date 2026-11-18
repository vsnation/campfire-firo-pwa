// Renders the app icons from Firo PWA's logo, Spark Seal (src/img/logo.svg, square, the app's own
// mark), on the icon background (#262d4a) with the installed Google Chrome. Dev-only; the PNGs are
// committed in src/icons/ (test/unit/icons.test.mjs checks each is the logo, not a blank or a
// broken-image square).
//
//   node tools/make_icons.mjs
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const svg = await readFile(join(src, 'img', 'logo.svg'), 'utf8');
const BG = '#262d4a';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// [file, size, logo width (= height) as a fraction of the icon]
const ICONS = [
  ['icon-512.png', 512, 0.66],
  ['icon-192.png', 192, 0.66],
  ['apple-touch-icon.png', 180, 0.64],
  ['icon-maskable-512.png', 512, 0.56], // the small spark's tip inside the 80% safe circle (at most 0.77)
];

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await mkdir(join(src, 'icons'), { recursive: true });
for (const [file, size, frac] of ICONS) {
  const h = Math.round(size * frac);
  const w = h;
  const html = `<!doctype html><html><body style="margin:0;background:${BG};width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
    <div style="width:${w}px;height:${h}px">${svg.replace('<svg ', `<svg style="width:100%;height:100%" `)}</div></body></html>`;
  // Headless Chrome lays out no window under ~500 px: a 180 px window drew the logo twice. The
  // window is at least 512 px; the icon is drawn in its top-left corner and clipped.
  await page.setViewportSize({ width: Math.max(size, 512), height: Math.max(size, 512) });
  await page.setContent(html);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
  await writeFile(join(src, 'icons', file), png);
  console.log(`icons/${file} ${size}x${size} ${png.length} bytes`);
}
await browser.close();
