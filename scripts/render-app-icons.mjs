// The desktop application's icon set, rendered from the bead artwork exactly.
//
// **Why this is not `cargo tauri icon`.** It was, until direction 04. The Tauri CLI takes
// one large PNG and resamples it down with a smooth filter, which is the right thing for
// a vector mark and the wrong thing for this one: measured on its own output here, the
// 32 px icon came back with **268 partly transparent pixels** and a soft halo around every
// cell — a blur of 8-bit art, which is worse than either the art or a circle. The mark is
// authored on a 16-cell grid precisely so that no resampler is ever involved, so the set
// is rendered at each size directly from the grid and packed into the two containers
// Windows and macOS want. Same output layout as the CLI produced, same PNG-in-ICO entries
// (16, 24, 32, 48, 64, 256), so nothing downstream had to change.
//
// Zero dependencies, no network, and no browser: a PNG encoder, an ICO container and an
// ICNS container are about a hundred lines between them, and `render-bead-png.mjs` has
// the encoder already.
//
// Usage:
//   node scripts/render-app-icons.mjs           write apps/desktop/icons/
//   node scripts/render-app-icons.mjs --strip   write docs/design/icon-04-applied.png

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRID, beadGrid, renderBead, toPng } from './render-bead-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ICONS = resolve(REPO, 'apps/desktop/icons');

/** The colour master, and the monochrome template beside it. */
const COLOUR = resolve(REPO, 'packages/ui/assets/nazar.svg');
const TEMPLATE = resolve(REPO, 'docs/design/icon-04-pixel-bead-mono.svg');

/** The loose PNGs `tauri.conf.json` names, plus the one Tauri uses as a window icon. */
const LOOSE = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
];

/** The sizes inside `icon.ico`. Exactly what the Tauri CLI used to put there. */
const ICO_SIZES = [16, 24, 32, 48, 64, 256];

/**
 * The sizes inside `icon.icns`, by four-character type.
 *
 * Only the PNG-carrying types, which is everything macOS 10.7 and later reads. The CLI
 * also wrote `is32`/`il32`/`s8mk`/`l8mk` — RLE-packed 24-bit art with a separate mask,
 * for Mac OS X 10.0 — and nothing this project ships has ever run there.
 */
const ICNS_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

/** One PNG of the mark at `size`, as bytes. */
function beadPng(size, cells) {
  return toPng(size, size, renderBead(size, cells));
}

/**
 * Pack PNGs into an `.ico`.
 *
 * `ICONDIR` then one 16-byte `ICONDIRENTRY` per image then the images. A dimension of
 * 256 is written as the byte 0, which is how the format says "256" in one byte. The
 * entries carry PNG rather than a DIB at every size, which is what the Tauri CLI wrote
 * here before and what the NSIS installer has been reading since WP8.
 */
function toIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // palette entries: none
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([directory, ...images.map((image) => image.png)]);
}

/** Pack PNGs into an `.icns`: the magic, the total length, then type/length/data runs. */
function toIcns(entries) {
  const blocks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const total = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...blocks]);
}

function writeIconSet() {
  const cells = beadGrid(COLOUR);
  mkdirSync(ICONS, { recursive: true });

  const written = [];
  for (const [name, size] of LOOSE) {
    writeFileSync(resolve(ICONS, name), beadPng(size, cells));
    written.push(`${name} (${size})`);
  }

  writeFileSync(
    resolve(ICONS, 'icon.ico'),
    toIco(ICO_SIZES.map((size) => ({ size, png: beadPng(size, cells) }))),
  );
  writeFileSync(
    resolve(ICONS, 'icon.icns'),
    toIcns(ICNS_TYPES.map(([type, size]) => ({ type, png: beadPng(size, cells) }))),
  );

  process.stdout.write(
    `icons: ${written.join(', ')}, icon.ico (${ICO_SIZES.join('/')}), icon.icns (${ICNS_TYPES.length} entries)\n`,
  );
}

/* ------------------------------------------------------------------ *
 * The applied-icon strip for docs/design
 * ------------------------------------------------------------------ */

/** The sizes `icon::size_for_scale` hands the tray, at 100 % through 400 % scaling. */
const TRAY_SIZES = [16, 20, 24, 32, 64];

/** How far to blow the 16 px render up so a reader can count the cells. */
const ZOOM = 8;

/** The two grounds a tray icon lands on. Not themed: this is a docs artefact. */
const BANDS = [
  [0xf6, 0xf7, 0xf9],
  [0x14, 0x18, 0x1f],
];

const PAD = 16;
const GAP = 12;

/** Paint one image into another at (x, y), source alpha over destination. */
function blit(canvas, width, image, size, x, y) {
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const from = (row * size + column) * 4;
      if (image[from + 3] === 0) continue;
      const to = ((y + row) * width + (x + column)) * 4;
      image.copy(canvas, to, from, from + 4);
    }
  }
}

/**
 * The strip: every size the tray actually asks for, at true size and enlarged, on a
 * light ground and a dark one.
 *
 * Two bands, identical content. Left to right: 16, 20, 24, 32 and 64 px true renders,
 * then the 16 px render at eight times, then the 16 px *template* at eight times. The
 * enlargements are integer multiples and nearest neighbour, so what the image shows is
 * the cells and not an interpretation of them.
 */
function writeStrip() {
  const colour = beadGrid(COLOUR);
  const template = beadGrid(TEMPLATE);

  const zoomed = GRID * ZOOM;
  const items = [
    ...TRAY_SIZES.map((size) => ({ size, cells: colour })),
    { size: zoomed, cells: colour },
    { size: zoomed, cells: template },
  ];

  const width =
    PAD * 2 + items.reduce((sum, item) => sum + item.size, 0) + GAP * (items.length - 1);
  const bandHeight = zoomed + PAD * 2;
  const height = bandHeight * BANDS.length;

  const canvas = Buffer.alloc(width * height * 4);
  BANDS.forEach((ground, band) => {
    const top = band * bandHeight;
    for (let y = top; y < top + bandHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        canvas[at] = ground[0];
        canvas[at + 1] = ground[1];
        canvas[at + 2] = ground[2];
        canvas[at + 3] = 0xff;
      }
    }

    let x = PAD;
    for (const item of items) {
      const image = renderBead(item.size, item.cells);
      // Centred in the band, so the true-size renders sit level with the big ones.
      blit(canvas, width, image, item.size, x, top + Math.round((bandHeight - item.size) / 2));
      x += item.size + GAP;
    }
  });

  const output = resolve(REPO, 'docs/design/icon-04-applied.png');
  writeFileSync(output, toPng(width, height, canvas));
  process.stdout.write(`strip: ${width}x${height} to ${output}\n`);
}

if (process.argv.includes('--strip')) writeStrip();
else writeIconSet();
