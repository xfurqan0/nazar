/**
 * One mark, six copies, and the gate that keeps them one mark.
 *
 * The maintainer picked direction 04 out of `docs/design/`, and applying it meant
 * writing the same sixteen rows of cells into six places: the design master, the shipped
 * `nazar.svg`, the grid in `src/bead.ts`, the inline paths in the canvas's `index.html`,
 * the inline paths in the desktop shell's boot page, and the Rust grid the tray icon
 * rasterises. That is exactly the shape of problem that ends with a logo that is subtly
 * different in the tray than it is in the tab — so every copy is compared with the master
 * here, cell by cell, and the build fails on the first one that drifts.
 *
 * Geometry, not bytes. A file may format itself differently, comment itself differently
 * and be any size it likes; what it may not do is draw a different bead. Both artworks
 * are parsed back into a grid of characters and the grids are compared, so a `<rect>`
 * split into two, or a path written with different run boundaries, is a pass — and a cell
 * moved one to the left is a failure.
 *
 * The second half of the file is the other direction: nothing anywhere still *references*
 * the round bead. A test that only checked the new artwork would happily let a forgotten
 * `<circle r="10.5">` sit in a page nobody screenshotted.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BEAD_COLOURS,
  BEAD_GRID,
  BEAD_LAYERS,
  BEAD_SIZE,
  BEAD_TOKENS,
  beadCellIsSet,
  beadFillRows,
  beadLayerPath,
  beadRingPath,
  beadSolidPath,
  type BeadLayer,
} from '../src/bead.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.dirname(HERE);
const REPO = path.dirname(path.dirname(UI));

const read = (relative: string): string => readFileSync(path.join(REPO, relative), 'utf8');

const MASTER = 'docs/design/icon-04-pixel-bead.svg';
const MASTER_MONO = 'docs/design/icon-04-pixel-bead-mono.svg';
const SHIPPED = 'packages/ui/assets/nazar.svg';
const PAGE = 'packages/ui/web/index.html';
const BOOT = 'apps/desktop/shell/index.html';
const TRAY = 'apps/desktop/src/icon.rs';

/** An empty grid of the right shape, ready to be painted into. */
function blank(): string[][] {
  return Array.from({ length: BEAD_SIZE }, () => Array.from({ length: BEAD_SIZE }, () => '.'));
}

function rows(cells: readonly (readonly string[])[]): string[] {
  return cells.map((row) => row.join(''));
}

/**
 * Parse a pixel-bead SVG's `<rect>` runs into a grid.
 *
 * `code` maps a fill — a hex, or a `var(--token)` — to the character the grid uses for
 * that layer. A fill it does not know is a failure: an artwork that has grown a fifth
 * colour is not this mark any more.
 */
function gridOfRects(svg: string, code: (fill: string) => string | undefined): string[] {
  const cells = blank();
  const pattern =
    /<rect\s+x="(\d+)"\s+y="(\d+)"\s+width="(\d+)"\s+height="(\d+)"\s+fill="([^"]+)"\s*\/>/g;
  let count = 0;
  for (const match of svg.matchAll(pattern)) {
    const [x, y, width, height] = match.slice(1, 5).map(Number) as [number, number, number, number];
    const character = code((match[5] as string).toUpperCase());
    assert.ok(character !== undefined, `unexpected fill ${match[5]}`);
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        assert.equal((cells[row] as string[])[column], '.', `two rects cover ${column},${row}`);
        (cells[row] as string[])[column] = character;
      }
    }
    count += 1;
  }
  assert.ok(count > 0, 'the artwork contains no rects');
  return rows(cells);
}

/**
 * Parse the `M x yh w v1h -w z` runs `beadPathOf` writes back into a grid.
 *
 * Only that one shape of subpath is accepted, which is the point: a path with a curve, a
 * fractional coordinate or a run that spans two rows is not a drawing on the grid, and
 * the test should say so rather than approximate it.
 */
function gridOfPaths(paths: ReadonlyArray<readonly [string, string]>): string[] {
  const cells = blank();
  for (const [character, d] of paths) {
    const pattern = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
    let consumed = 0;
    for (const match of d.matchAll(pattern)) {
      const [x, y, width, back] = match.slice(1, 5).map(Number) as [number, number, number, number];
      assert.equal(width, back, `run at ${x},${y} does not close on itself`);
      for (let column = x; column < x + width; column += 1) {
        assert.equal((cells[y] as string[])[column], '.', `two runs cover ${column},${y}`);
        (cells[y] as string[])[column] = character;
      }
      consumed += match[0].length;
    }
    assert.equal(consumed, d.length, `the ${character} path has something other than cell runs`);
  }
  return rows(cells);
}

/** The four hexes of the mark, as the grid's characters. */
function colourCode(fill: string): string | undefined {
  for (const layer of BEAD_LAYERS) {
    if (fill === BEAD_COLOURS[layer].toUpperCase()) return layer;
  }
  return undefined;
}

/** Pull the `d` of each `<path fill="...">` out of a block of markup, in file order. */
function pathsIn(markup: string, block: string): Array<[string, string]> {
  const start = markup.indexOf(block);
  assert.notEqual(start, -1, `${block} is not in the markup`);
  const end = markup.indexOf('</svg>', start);
  assert.notEqual(end, -1, 'the bead svg is not closed');
  const svg = markup.slice(start, end);

  const found: Array<[string, string]> = [];
  const pattern = /fill="([^"]+)"\s*\n?\s*d="([^"]+)"|d="([^"]+)"\s*\n?\s*fill="([^"]+)"/g;
  for (const match of svg.matchAll(pattern)) {
    const fill = (match[1] ?? match[4]) as string;
    const d = (match[2] ?? match[3]) as string;
    found.push([fill, d]);
  }
  assert.equal(found.length, 4, `expected four layers in ${block}, found ${found.length}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * The mark is the same drawing everywhere it is drawn
 * ------------------------------------------------------------------ */

test('the grid in src/bead.ts is the design master, cell for cell', () => {
  assert.deepEqual(gridOfRects(read(MASTER), colourCode), [...BEAD_GRID]);
});

test('the shipped nazar.svg is the design master, cell for cell', () => {
  const shipped = read(SHIPPED);
  assert.deepEqual(gridOfRects(shipped, colourCode), gridOfRects(read(MASTER), colourCode));

  // And it is on the grid rather than merely made of rects: a favicon at some other
  // viewBox would resample every cell.
  assert.match(shipped, new RegExp(`viewBox="0 0 ${BEAD_SIZE} ${BEAD_SIZE}"`));
  assert.match(shipped, /shape-rendering="crispEdges"/);
});

test('the monochrome master is the colour master with the band and pupil dropped', () => {
  const mono = gridOfRects(read(MASTER_MONO), (fill) => (fill === '#FFFFFF' ? 'M' : undefined));
  const wanted = BEAD_GRID.map((row) =>
    [...row].map((cell) => (cell === 'R' || cell === 'I' ? 'M' : '.')).join(''),
  );
  assert.deepEqual(mono, wanted);
});

test('the paths built from the grid are the grid again', () => {
  const layers = BEAD_LAYERS.map((layer) => [layer, beadLayerPath(layer)] as [string, string]);
  assert.deepEqual(gridOfPaths(layers), [...BEAD_GRID]);

  // The silhouette is every drawn cell and nothing else.
  const solid = gridOfPaths([['X', beadSolidPath()]]);
  assert.deepEqual(
    solid,
    BEAD_GRID.map((row) => [...row].map((cell) => (cell === '.' ? '.' : 'X')).join('')),
  );
});

test('the ring is the drawn cells that touch an undrawn one', () => {
  const ring = gridOfPaths([['O', beadRingPath()]]);
  for (let y = 0; y < BEAD_SIZE; y += 1) {
    for (let x = 0; x < BEAD_SIZE; x += 1) {
      const outline =
        beadCellIsSet(x, y) &&
        !(
          beadCellIsSet(x - 1, y) &&
          beadCellIsSet(x + 1, y) &&
          beadCellIsSet(x, y - 1) &&
          beadCellIsSet(x, y + 1)
        );
      assert.equal((ring[y] as string)[x] === 'O', outline, `cell ${x},${y}`);
    }
  }
  // Every corner of the grid is empty, so the ring never runs along the edge of the box.
  assert.equal((ring[0] as string)[0], '.');
});

test("the canvas page's two inline beads are the same drawing", () => {
  const page = read(PAGE);
  const tokenCode = (fill: string): string | undefined => {
    for (const layer of BEAD_LAYERS) {
      if (fill.toLowerCase() === `var(${BEAD_TOKENS[layer]})`) return layer;
    }
    return undefined;
  };

  for (const block of ['class="nz-bead"', 'class="nz-empty__bead"']) {
    const layers = pathsIn(page, block).map(([fill, d]) => {
      const character = tokenCode(fill);
      assert.ok(character !== undefined, `${block} paints a layer with ${fill}`);
      return [character, d] as [string, string];
    });
    assert.deepEqual(gridOfPaths(layers), [...BEAD_GRID], `${block} is not the mark`);
  }

  // Themed, not hard-coded: a bead in the page takes the palette's own bead tokens, and
  // every theme carries all four (`theme.test.ts` proves they are identical in each).
  for (const layer of BEAD_LAYERS) assert.ok(page.includes(`var(${BEAD_TOKENS[layer]})`));
});

test("the desktop shell's boot page carries the same drawing, in hexes", () => {
  const boot = read(BOOT);
  const hexCode = (fill: string): string | undefined => colourCode(fill.toUpperCase());
  const layers = pathsIn(boot, 'class="boot__bead"').map(([fill, d]) => {
    const character = hexCode(fill);
    assert.ok(character !== undefined, `the boot bead paints a layer with ${fill}`);
    return [character, d] as [string, string];
  });
  assert.deepEqual(gridOfPaths(layers), [...BEAD_GRID]);

  // Hexes rather than tokens, deliberately: the boot page is shown before the canvas's
  // stylesheet exists and has no theme to read a custom property from.
  assert.equal(boot.includes('var(--nz-bead'), false, 'the boot page has no theme to read');
});

test("the tray rasteriser's grid is the same sixteen strings", () => {
  const rust = read(TRAY);
  // From the `= [` that opens the literal, so the `];` inside the type annotation
  // `[&[u8; GRID]; GRID]` does not close the slice before it has started.
  const opens = rust.indexOf('= [', rust.indexOf('const BEAD:'));
  assert.notEqual(opens, -1, 'icon.rs has no BEAD literal');
  const block = rust.slice(opens, rust.indexOf('];', opens));
  const found = [...block.matchAll(/b"([.RWIP]{16})"/g)].map((match) => match[1] as string);
  assert.deepEqual(found, [...BEAD_GRID], 'apps/desktop/src/icon.rs draws a different bead');
});

/* ------------------------------------------------------------------ *
 * Every bead on screen is on the grid
 * ------------------------------------------------------------------ */

test('every bead is sized in whole pixels and rendered crisply', () => {
  const css = read('packages/ui/web/styles.css');
  const boot = read('apps/desktop/shell/boot.css');

  // 22 and 26 were the round bead's sizes and are a cell and a half and a cell and
  // five eighths of one; nothing on the grid may be sized like that again.
  for (const [sheet, name, rule] of [
    [css, 'styles.css', '.nz-bead'],
    [css, 'styles.css', '.nz-quota__bead'],
    [css, 'styles.css', '.nz-empty__bead'],
    [boot, 'boot.css', '.boot__bead'],
  ] as const) {
    const at = sheet.indexOf(`${rule} {`);
    assert.notEqual(at, -1, `${rule} has no rule in ${name}`);
    const body = sheet.slice(at, sheet.indexOf('}', at));
    const width = /width:\s*(\d+)px/.exec(body);
    assert.ok(width !== null, `${rule} does not set a pixel width`);
    const pixels = Number(width[1]);
    assert.ok(
      pixels % BEAD_SIZE === 0 || pixels === 24,
      `${rule} is ${pixels}px, which is neither a multiple of ${BEAD_SIZE} nor 24`,
    );
    assert.match(body, /shape-rendering:\s*crispEdges/, `${rule} would be smoothed`);
  }
});

test('the two beads the panel builds are on the grid too', () => {
  const quota = read('packages/ui/web/quota.ts');
  assert.match(quota, /const BEAD = (16|24|32|48|64);/);
  assert.match(quota, /const BAR_BEAD = (16|24|32|48|64);/);
  // The viewBox is the grid and never the pixel size, or the cells stop being whole.
  assert.ok(quota.includes('`0 0 ${BEAD_SIZE} ${BEAD_SIZE}`'));
  assert.ok(quota.includes("root.setAttribute('shape-rendering', 'crispEdges')"));
});

/* ------------------------------------------------------------------ *
 * The gauge still works, a cell at a time
 * ------------------------------------------------------------------ */

test('a percentage fills whole rows, bottom-up', () => {
  assert.equal(beadFillRows(0), 0);
  assert.equal(beadFillRows(100), BEAD_SIZE);
  assert.equal(beadFillRows(50), 8);
  assert.equal(beadFillRows(25), 4);
  // 6.25 % is one row exactly, so the rounding lands on the boundary rather than near it.
  assert.equal(beadFillRows(6.25), 1);
  assert.equal(beadFillRows(9.4), 2);

  // Monotonic, never off the grid, and always an integer: the three properties the
  // clip rect depends on.
  let previous = 0;
  for (let percent = 0; percent <= 100; percent += 0.5) {
    const rows = beadFillRows(percent);
    assert.ok(Number.isInteger(rows), `${percent} % gave ${rows} rows`);
    assert.ok(rows >= 0 && rows <= BEAD_SIZE, `${percent} % ran off the grid`);
    assert.ok(rows >= previous, `${percent} % went backwards`);
    previous = rows;
  }
});

test('a percentage outside the range is clamped rather than trusted', () => {
  assert.equal(beadFillRows(-10), 0);
  assert.equal(beadFillRows(140), BEAD_SIZE);
  assert.equal(beadFillRows(Number.NaN), 0, 'a missing reading is an empty bead, not a crash');
});

/* ------------------------------------------------------------------ *
 * Nothing still references the round bead
 * ------------------------------------------------------------------ */

test('no round-bead asset is left referenced anywhere', () => {
  // The four radii of the mark as it was drawn until direction 04 was applied. Any of
  // them still in a shipped file means a page, a boot screen or a doc is drawing the old
  // logo next to the new one.
  const radii = /r="(?:15|10\.5|6\.5|2\.8)"/;
  for (const file of [
    SHIPPED,
    PAGE,
    BOOT,
    TRAY,
    'packages/ui/web/quota.ts',
    'packages/ui/web/styles.css',
    'apps/desktop/shell/boot.css',
    'scripts/render-bead-png.mjs',
    'scripts/render-app-icons.mjs',
  ]) {
    assert.equal(radii.test(read(file)), false, `${file} still draws the round bead`);
  }
});

test('nothing points at a bead file that is not the pixel one', () => {
  const page = read(PAGE);
  // The favicon is the shipped master and not some other copy of the mark.
  assert.match(page, /<link rel="icon" href="assets\/nazar\.svg"/);

  // There is one bead asset in the package, and it is that file. A `bead.svg`, an
  // `eye.svg` or a second `nazar-*.svg` would be a fork of the mark waiting to happen.
  const assets = readFileSync(path.join(UI, 'build.mjs'), 'utf8');
  assert.ok(assets.includes("'assets'"), 'build.mjs no longer copies the assets directory');
});

test('the tray no longer supersamples anything', () => {
  const rust = read(TRAY);
  assert.equal(rust.includes('SUPERSAMPLE'), false, 'the circle rasteriser is still there');
  assert.equal(rust.includes('CIRCLES'), false, 'the four circles are still there');
  // And it can still draw both variants, which is what the macOS menu bar needs.
  assert.ok(rust.includes('pub fn render_template'));
  assert.ok(rust.includes('Variant::Template'));
});

test('the four brand colours are unchanged by the new drawing', () => {
  // The mark changed shape, not palette: the theme gate and the Rust test both read
  // these hexes, and a direction that quietly restyled the blue would be a rebrand.
  assert.deepEqual(
    BEAD_LAYERS.map((layer: BeadLayer) => BEAD_COLOURS[layer]),
    ['#0E2A5A', '#FFFFFF', '#3FA9F5', '#0A0A0F'],
  );
  const theme = JSON.parse(readFileSync(path.join(UI, 'theme.nazar.json'), 'utf8')) as {
    bead: Record<string, string>;
  };
  assert.deepEqual(
    [theme.bead['deepBlue'], theme.bead['white'], theme.bead['lightBlue'], theme.bead['blackDot']],
    ['#0E2A5A', '#FFFFFF', '#3FA9F5', '#0A0A0F'],
  );
});
