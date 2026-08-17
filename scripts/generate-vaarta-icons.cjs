/**
 * Regenerates every Vaarta logo asset from the single source-of-truth logomark
 * (the waveform-over-chevron mark shipped in external/ekascribe as vaarta-icon.svg).
 *
 * macOS only — it shells out to `sips` for SVG rasterisation and `iconutil` for
 * the .icns. The .ico is assembled by hand (PNG-in-ICO, Vista+).
 *
 *   node scripts/generate-vaarta-icons.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vaarta-icons-'));

const PRIMARY = '#215FFF';
const WHITE = '#FFFFFF';

// Logomark paths, authored in a 128x128 viewBox.
const PATH_BARS =
  'M64.5618 28.5927C62.7177 28.5927 61.2222 30.061 61.2222 31.8754V58.1373C61.2222 59.9516 62.7177 61.42 64.5618 61.42C66.406 61.42 67.9015 59.9516 67.9015 58.1373V31.8754C67.9015 30.061 66.406 28.5927 64.5618 28.5927ZM84.5997 38.4409C82.7556 38.4409 81.2601 39.9092 81.2601 41.7236V48.2891C81.2601 50.1034 82.7556 51.5718 84.5997 51.5718C86.4439 51.5718 87.9394 50.1034 87.9394 48.2891V41.7236C87.9394 39.9092 86.4439 38.4409 84.5997 38.4409ZM44.5239 38.4409C42.6798 38.4409 41.1843 39.9092 41.1843 41.7236V48.2891C41.1843 50.1034 42.6798 51.5718 44.5239 51.5718C46.3681 51.5718 47.8636 50.1034 47.8636 48.2891V41.7236C47.8636 39.9092 46.3681 38.4409 44.5239 38.4409ZM74.5808 35.1581C72.7366 35.1581 71.2411 36.6265 71.2411 38.4409V51.5718C71.2411 53.3862 72.7366 54.8545 74.5808 54.8545C76.4249 54.8545 77.9204 53.3862 77.9204 51.5718V38.4409C77.9204 36.6265 76.4249 35.1581 74.5808 35.1581ZM54.5429 35.1581C52.6987 35.1581 51.2032 36.6265 51.2032 38.4409V51.5718C51.2032 53.3862 52.6987 54.8545 54.5429 54.8545C56.387 54.8545 57.8825 53.3862 57.8825 51.5718V38.4409C57.8825 36.6265 56.387 35.1581 54.5429 35.1581Z';
const PATH_CHEVRON =
  'M63.898 99.4078C61.3097 99.4078 59.0619 99.078 57.1548 98.4184C55.2476 97.7587 53.6128 96.7033 52.2506 95.2522L17.5125 56.0708C16.5589 54.9495 16.2184 53.927 16.4908 53.0036C16.7633 52.0801 17.6488 51.3215 19.1473 50.7279C20.782 50.1342 22.9616 49.8374 25.6862 49.8374C28.0021 49.8374 29.8411 50.1012 31.2034 50.6289C32.5657 51.1566 33.8598 52.0801 35.0859 53.3993L67.1675 91.6902H61.4459L94.3449 53.3993C95.4347 52.0801 96.6608 51.1566 98.023 50.6289C99.5215 50.1012 101.565 49.8374 104.153 49.8374C106.469 49.8374 108.24 50.1342 109.466 50.7279C110.828 51.3215 111.646 52.0801 111.918 53.0036C112.191 53.927 111.782 54.9165 110.692 55.9719L75.7498 95.2522C74.5238 96.7033 72.889 97.7587 70.8456 98.4184C68.9384 99.078 66.6226 99.4078 63.898 99.4078Z';

// Tight bounding box of the two paths inside the 128x128 viewBox.
const BBOX = { x: 16.39, y: 28.59, w: 95.8, h: 70.82 };
const MARK_ASPECT = BBOX.w / BBOX.h; // ~1.353

const paths = (fill) =>
  `<path d="${PATH_BARS}" fill="${fill}"/><path d="${PATH_CHEVRON}" fill="${fill}"/>`;

/** Square canvas with the mark centred, its bbox occupying `coverage` of the width. */
function squareMarkSvg({ size, fill, coverage }) {
  const markW = size * coverage;
  const scale = markW / BBOX.w;
  const tx = (size - markW) / 2 - BBOX.x * scale;
  const ty = (size - BBOX.h * scale) / 2 - BBOX.y * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none"><g transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale)})">${paths(fill)}</g></svg>`;
}

/** Canvas cropped to the mark's natural aspect ratio. */
function tightMarkSvg({ width, fill }) {
  const scale = width / BBOX.w;
  const height = Math.round(BBOX.h * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none"><g transform="translate(${round(-BBOX.x * scale)} ${round(-BBOX.y * scale)}) scale(${round(scale)})">${paths(fill)}</g></svg>`;
}

/** App-icon treatment: white mark on a full-bleed primary-blue rounded square. */
function appIconSvg({ size, coverage }) {
  const markW = size * coverage;
  const scale = markW / BBOX.w;
  const tx = (size - markW) / 2 - BBOX.x * scale;
  const ty = (size - BBOX.h * scale) / 2 - BBOX.y * scale;
  const r = round(size * 0.2237); // Apple's corner-radius ratio
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${PRIMARY}"/><g transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale)})">${paths(WHITE)}</g></svg>`;
}

const round = (n) => Number(n.toFixed(4));

function write(relPath, contents) {
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  console.log('  svg  ' + relPath);
}

/** Rasterise an SVG string to a PNG of exact pixel dimensions. */
function raster(svg, relPath, width, height) {
  const src = path.join(TMP, 'src-' + Math.random().toString(36).slice(2) + '.svg');
  fs.writeFileSync(src, svg);
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  execFileSync('sips', [
    '-s', 'format', 'png',
    '--resampleHeightWidth', String(height), String(width),
    src, '--out', abs,
  ], { stdio: 'ignore' });
  console.log(`  png  ${relPath} (${width}x${height})`);
  return abs;
}

const rasterSquare = (svg, relPath, size) => raster(svg, relPath, size, size);

/** Assemble a PNG-based .ico from already-rendered square PNGs. */
function writeIco(relPath, pngPaths) {
  const pngs = pngPaths.map((p) => fs.readFileSync(p));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((png, i) => {
    // Dimensions live at bytes 16..24 of the PNG IHDR.
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const e = 16 * i;
    dir.writeUInt8(w >= 256 ? 0 : w, e);
    dir.writeUInt8(h >= 256 ? 0 : h, e + 1);
    dir.writeUInt8(0, e + 2); // palette size
    dir.writeUInt8(0, e + 3); // reserved
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });

  const abs = path.join(ROOT, relPath);
  fs.writeFileSync(abs, Buffer.concat([header, dir, ...pngs]));
  console.log(`  ico  ${relPath} (${pngs.length} sizes)`);
}

// ---------------------------------------------------------------------------

console.log('Vaarta logo sources');
write('assets/logo/vaarta-logomark.svg', squareMarkSvg({ size: 128, fill: PRIMARY, coverage: 0.7484 }));
write('assets/logo/vaarta-logomark-white.svg', squareMarkSvg({ size: 128, fill: WHITE, coverage: 0.7484 }));
write('assets/logo/vaarta-app-icon.svg', appIconSvg({ size: 1024, coverage: 0.62 }));

// Icon Composer source (.icon) — white mark, tight canvas, blue gradient supplied by icon.json.
write('assets/icons/icon-mac.icon/Assets/vaarta-logomark.svg', tightMarkSvg({ width: 958, fill: WHITE }));

console.log('Electron app icon');
const ICONSET = 'build/icons/icon.iconset';
const iconsetSizes = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of iconsetSizes) {
  rasterSquare(appIconSvg({ size, coverage: 0.62 }), path.join(ICONSET, name), size);
}
rasterSquare(appIconSvg({ size: 512, coverage: 0.62 }), 'build/icons/icon.png', 512);

execFileSync('iconutil', ['-c', 'icns', path.join(ROOT, ICONSET), '-o', path.join(ROOT, 'build/icons/icon.icns')]);
console.log('  icns build/icons/icon.icns');

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((size) =>
  rasterSquare(appIconSvg({ size, coverage: 0.62 }), path.posix.join('build/icons/.ico-tmp', `${size}.png`), size),
);
writeIco('build/icons/icon.ico', icoPngs);
fs.rmSync(path.join(ROOT, 'build/icons/.ico-tmp'), { recursive: true, force: true });

console.log('Tray icons');
// macOS menu bar: monochrome template, inverted automatically by the system.
rasterSquare(squareMarkSvg({ size: 16, fill: '#000000', coverage: 1 }), 'build/icons/tray/iconTemplate.png', 16);
rasterSquare(squareMarkSvg({ size: 32, fill: '#000000', coverage: 1 }), 'build/icons/tray/iconTemplate@2x.png', 32);
// Windows light taskbar: filled blue tile so the mark stays legible.
rasterSquare(appIconSvg({ size: 32, coverage: 0.72 }), 'build/icons/tray/tray-light.png', 32);
// Windows dark taskbar: blue mark on transparency.
rasterSquare(squareMarkSvg({ size: 32, fill: PRIMARY, coverage: 1 }), 'build/icons/tray/tray-dark.png', 32);

console.log('macOS helper assets');
const XC = 'mac/EkaCareDesktopHelper/EkaCareDesktopHelper/Resources/Assets.xcassets';
rasterSquare(squareMarkSvg({ size: 256, fill: PRIMARY, coverage: 1 }), `${XC}/ekaLogoBlue.imageset/ekaLogoBlue.png`, 256);
write(`${XC}/ekaLogoWhite.imageset/Vector.svg`, tightMarkSvg({ width: 128, fill: WHITE }));

console.log('Windows helper assets');
const WIN = 'windows/EkaDeskDocHelper/EkaDeskDocHelper/Assets';
raster(tightMarkSvg({ width: 256, fill: WHITE }), `${WIN}/ekascribe_logo_white.png`, 256, Math.round(256 / MARK_ASPECT));
raster(tightMarkSvg({ width: 256, fill: PRIMARY }), `${WIN}/EkaLogoBlue.png`, 256, Math.round(256 / MARK_ASPECT));

console.log('Renderer assets');
write('src/renderer/src/screens/auth/vaarta-icon.svg', squareMarkSvg({ size: 128, fill: PRIMARY, coverage: 0.7484 }));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('Done.');
