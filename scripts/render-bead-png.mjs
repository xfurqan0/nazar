// Rasterise a pixel-bead SVG to a square PNG, for `tauri icon` and for the docs.
//
// Why not a library: the bead is sixty integer rects on a 16x16 grid, and the alternative
// is pulling a rasteriser and its transitive tree into a project that has zero runtime
// dependencies and wants to keep the dev list short too. Reading the same SVG the canvas
// draws is also the only way the application icon and the artwork in the page cannot
// drift apart.
//
// **Nearest neighbour, on purpose.** Direction 04 is authored on the grid the tray uses,
// so a cell is a whole unit and a render at any multiple of 16 puts a whole square block
// of pixels inside each one. There is nothing to supersample and nothing to blend: every
// output pixel is one cell's colour at full alpha, or nothing at all. Enlarging with a
// smooth filter — which is what a browser does to an SVG without
// `image-rendering: pixelated` — would turn 8-bit art into a blur of it.
//
// The output is a build input, not a source file: `apps/desktop/icons/` is generated from
// it by `scripts/build-desktop.mjs --icons`, and the 1024 px source is gitignored.
//
// Usage: node scripts/render-bead-png.mjs [size] [output.png] [source.svg]

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_SOURCE = 'packages/ui/assets/nazar.svg';

/** The grid every pixel-bead master is authored on. */
export const GRID = 16;

/**
 * Read a pixel-bead SVG into a 16x16 array of `[r, g, b]`, `null` where nothing is drawn.
 *
 * Strict by design: a non-integer attribute, a rect that runs off the grid, or two rects
 * covering one cell are all failures rather than something to paint over. The masters are
 * hand-authored and there are sixty rects in one; if a file stops looking like that, the
 * icon set must not be regenerated from it silently.
 */
function readGrid(svg) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (viewBox === null) throw new Error('the artwork has no square viewBox at the origin');
  if (Number(viewBox[1]) !== GRID || Number(viewBox[2]) !== GRID) {
    throw new Error(`the artwork is not on the ${GRID}x${GRID} grid: ${viewBox[0]}`);
  }

  const cells = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => null));
  const pattern =
    /<rect\s+x="(\d+)"\s+y="(\d+)"\s+width="(\d+)"\s+height="(\d+)"\s+fill="#([0-9A-Fa-f]{6})"\s*\/>/g;

  let count = 0;
  for (const match of svg.matchAll(pattern)) {
    const [x, y, width, height] = match.slice(1, 5).map(Number);
    const hex = match[5];
    const rgb = [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
    if (x + width > GRID || y + height > GRID) {
      throw new Error(`a rect at ${x},${y} runs off the ${GRID}x${GRID} grid`);
    }
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        if (cells[row][column] !== null) throw new Error(`two rects cover cell ${column},${row}`);
        cells[row][column] = rgb;
      }
    }
    count += 1;
  }
  if (count === 0) throw new Error('the artwork contains no rects');
  return cells;
}

/** Blow the grid up to `size` pixels square, one cell to a block. */
export function renderBead(size, cells) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const row = cells[Math.floor((y * GRID) / size)];
    for (let x = 0; x < size; x += 1) {
      const cell = row[Math.floor((x * GRID) / size)];
      if (cell === null) continue;
      const at = (y * size + x) * 4;
      pixels[at] = cell[0];
      pixels[at + 1] = cell[1];
      pixels[at + 2] = cell[2];
      pixels[at + 3] = 0xff;
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode straight (non-premultiplied) RGBA pixels as a PNG. */
export function toPng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // bytes 10..12 stay zero: deflate, adaptive filtering, no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read an artwork file and hand back its cells. */
export function beadGrid(source = resolve(REPO, DEFAULT_SOURCE)) {
  return readGrid(readFileSync(source, 'utf8'));
}

// Run as a script rather than imported: rasterise one file.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const size = Number(process.argv[2] ?? 1024);
  if (!Number.isInteger(size) || size < GRID) throw new Error(`${size} is not a usable size`);
  if (size % GRID !== 0) {
    process.stderr.write(
      `warning: ${size} is not a multiple of ${GRID}, so the cells will be uneven widths\n`,
    );
  }
  const output = resolve(REPO, process.argv[3] ?? 'apps/desktop/icons/bead-1024.png');
  const source = resolve(REPO, process.argv[4] ?? DEFAULT_SOURCE);

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, toPng(size, size, renderBead(size, beadGrid(source))));
  process.stdout.write(`rendered ${size}x${size} bead to ${output}\n`);
}
