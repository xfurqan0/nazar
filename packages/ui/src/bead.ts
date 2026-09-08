/**
 * The bead, as sixteen rows of sixteen cells.
 *
 * The mark used to be four concentric circles, drawn once as `<circle>` in the
 * page, again as `<circle>` in the boot page, and a third time as a
 * supersampled rasteriser in `apps/desktop/src/icon.rs`. Three drawings of one
 * shape, kept honest by a test that only compared the four hexes.
 *
 * Direction 04 (`docs/design/icon-04-pixel-bead.svg`) replaced it, and the
 * reason it is worth a module is not the style: **the mark is now data**. A
 * 16x16 grid of cells is a thing a page, a boot screen, a tray rasteriser and
 * a PNG script can each draw from the same sixteen strings, and a thing a test
 * can compare against the design master character by character. There is no
 * geometry to get subtly wrong twice.
 *
 * Sixteen is the tray's own unit: at 16 px each cell is exactly one device
 * pixel, and every size above it that is a multiple of 16 is exact too. At the
 * in-between sizes Windows asks for at 1.25x and 1.5x scaling, a cell is one
 * or two pixels — uneven, but hard-edged, which is the whole bargain of pixel
 * art and strictly better than a resampled circle.
 *
 * Nothing here touches the DOM: `web/quota.ts` builds elements from it, and
 * `index.html` and the desktop boot page carry the same path data inline so
 * the mark is on screen before any script runs. `test/bead.test.ts` fails the
 * build if any of those four copies drifts from the master.
 */

/** The grid's extent, in cells, on both axes. Also the tray's native size. */
export const BEAD_SIZE = 16;

/**
 * The four layers, in painter's order, keyed by the character used in the grid.
 *
 * - `R` — the rim, `#0E2A5A`
 * - `W` — the white band, `#FFFFFF`
 * - `I` — the iris, `#3FA9F5`
 * - `P` — the pupil, `#0A0A0F`
 */
export const BEAD_LAYERS = ['R', 'W', 'I', 'P'] as const;

/** One of the four layer characters. */
export type BeadLayer = (typeof BEAD_LAYERS)[number];

/** The brand hex of each layer. The same four colours the circles carried. */
export const BEAD_COLOURS: Readonly<Record<BeadLayer, string>> = {
  R: '#0E2A5A',
  W: '#FFFFFF',
  I: '#3FA9F5',
  P: '#0A0A0F',
};

/**
 * The CSS custom property each layer takes on a themed surface.
 *
 * The hexes above are for files a theme cannot reach — the favicon, the icon
 * PNG, the boot page. Inside the canvas the bead is drawn from the theme's own
 * bead tokens, which every palette carries and which `theme.ts` asserts are
 * identical in all of them.
 */
export const BEAD_TOKENS: Readonly<Record<BeadLayer, string>> = {
  R: '--nz-bead-deep-blue',
  W: '--nz-bead-white',
  I: '--nz-bead-light-blue',
  P: '--nz-bead-black-dot',
};

/**
 * The mark itself. `.` is a cell that is not drawn at all.
 *
 * This is `docs/design/icon-04-pixel-bead.svg` transcribed: the master is
 * sixty `<rect>` runs, this is the same sixty runs as a picture you can read.
 * The design file stays the source of truth and the test compares the two.
 */
export const BEAD_GRID: readonly string[] = [
  '......RRRR......',
  '....RRRRRRRR....',
  '..RRRRWWWWRRRR..',
  '..RRWWWWWWWWRR..',
  '.RRWWWWIIWWWWRR.',
  '.RRWWIIIIIIWWRR.',
  'RRWWWIIIIIIWWWRR',
  'RRWWIIIPPIIIWWRR',
  'RRWWIIIPPIIIWWRR',
  'RRWWWIIIIIIWWWRR',
  '.RRWWIIIIIIWWRR.',
  '.RRWWWWIIWWWWRR.',
  '..RRWWWWWWWWRR..',
  '..RRRRWWWWRRRR..',
  '....RRRRRRRR....',
  '......RRRR......',
];

/** True when the cell at (x, y) is inside the grid and drawn at all. */
export function beadCellIsSet(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= BEAD_SIZE || y >= BEAD_SIZE) return false;
  return (BEAD_GRID[y] as string)[x] !== '.';
}

/** The layer of the cell at (x, y), or `undefined` where nothing is drawn. */
export function beadCellLayer(x: number, y: number): BeadLayer | undefined {
  if (x < 0 || y < 0 || x >= BEAD_SIZE || y >= BEAD_SIZE) return undefined;
  const character = (BEAD_GRID[y] as string)[x];
  return character === '.' ? undefined : (character as BeadLayer);
}

/**
 * Turn a predicate over the grid into one SVG path.
 *
 * Horizontal runs, one subpath each: `M x y h w v1 h-w z`. A path rather than
 * a rect per cell because the same shape then costs one attribute instead of
 * two hundred elements, and because `shape-rendering: crispEdges` applies to a
 * path exactly as it does to a rect — the cells stay square either way.
 *
 * Integer coordinates only, so nothing here can land on a half pixel.
 */
export function beadPathOf(include: (x: number, y: number) => boolean): string {
  const parts: string[] = [];
  for (let y = 0; y < BEAD_SIZE; y += 1) {
    let x = 0;
    while (x < BEAD_SIZE) {
      if (!include(x, y)) {
        x += 1;
        continue;
      }
      let width = 0;
      while (x + width < BEAD_SIZE && include(x + width, y)) width += 1;
      parts.push(`M${x} ${y}h${width}v1h-${width}z`);
      x += width;
    }
  }
  return parts.join('');
}

/** The path for one layer of the mark. */
export function beadLayerPath(layer: BeadLayer): string {
  return beadPathOf((x, y) => beadCellLayer(x, y) === layer);
}

/** The path for the whole silhouette: every cell that is drawn at all. */
export function beadSolidPath(): string {
  return beadPathOf(beadCellIsSet);
}

/**
 * The path for the outline: every drawn cell that touches an undrawn one.
 *
 * This is the pixel-native replacement for the 1 px `stroke` the round bead's
 * gauge had. A stroke on a pixel mark is exactly the wrong thing — it is a
 * half-pixel line down the side of a hard-edged shape — and a ring of whole
 * cells does the same job of separating the bead from whatever is behind it.
 */
export function beadRingPath(): string {
  return beadPathOf(
    (x, y) =>
      beadCellIsSet(x, y) &&
      !(
        beadCellIsSet(x - 1, y) &&
        beadCellIsSet(x + 1, y) &&
        beadCellIsSet(x, y - 1) &&
        beadCellIsSet(x, y + 1)
      ),
  );
}

/**
 * How many whole rows of the grid a percentage fills, counted from the bottom.
 *
 * The gauge in the usage panel rises through the bead as a window is spent,
 * and on a pixel grid it has to rise a **cell at a time**: a fill that stopped
 * three tenths of the way into a row would put one soft edge on a mark whose
 * entire point is that it has none.
 *
 * Rounded, not floored, so the top and the bottom behave the same way: 96.9 %
 * and above is a full bead, below 3.1 % is an empty one. The percentage is
 * written next to every bead in words, which is what keeps "nearly empty" and
 * "empty" apart for a reader who needs the difference.
 *
 * A reading that is not a number is no rows rather than a thrown clip rect: an
 * unknown window is drawn grey and says `unknown`, and that path must not be
 * able to take the page down on the way.
 */
export function beadFillRows(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.round((clamped * BEAD_SIZE) / 100);
}
