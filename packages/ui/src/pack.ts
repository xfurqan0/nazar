/**
 * Where the cards go.
 *
 * WP4 arranged sessions in a grid of fixed columns and that was the whole
 * story. WP4c makes the canvas a canvas: a card can be dragged anywhere and
 * stays there, so placement splits into two jobs that this file owns and the
 * DOM layer only calls.
 *
 * - **`packShelves`** is the default and the *Arrange* action: shelf packing,
 *   width first. Cards go left to right until the next one would run past the
 *   shelf width, then a new shelf starts below the tallest card of the last
 *   one. This is the fix for "all my sessions are stacked in one column": the
 *   old grid capped a card at however many columns fitted the browser window,
 *   so a three-column card in a four-column window left one free column and
 *   every following card wrapped.
 * - **`firstFreeSlot`** places a session that has just appeared without moving
 *   anything the user has already arranged: the topmost, then leftmost, corner
 *   where the new card touches none of the placed ones.
 *
 * Nothing here knows about sessions, storage or the DOM.
 */
import type { Box } from './layout.js';

export interface SizedBox {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PackSpec {
  /** Cards wrap once a shelf would grow past this. */
  readonly shelfWidth: number;
  readonly gap: number;
}

export interface PackResult {
  readonly placements: readonly Placement[];
  readonly bounds: Box;
}

/** Do two placements share any area? Touching edges do not count. */
export function overlaps(a: Placement, b: Placement): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** The box around a set of placements. Empty input is a zero box. */
export function boundsOfPlacements(placements: readonly Placement[]): Box {
  if (placements.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const one of placements) {
    if (one.x < minX) minX = one.x;
    if (one.y < minY) minY = one.y;
    if (one.x + one.width > maxX) maxX = one.x + one.width;
    if (one.y + one.height > maxY) maxY = one.y + one.height;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * How wide a shelf should be for this set of cards.
 *
 * Three pulls, and the order of them is the whole answer to "why is everything
 * in one column".
 *
 * 1. **The window**, because "fill the width, then wrap" is what was asked for.
 * 2. **Two of the widest card**, whenever there is more than one card. A canvas
 *    of three 1,128 px cards in a 1,484 px window fits exactly one per shelf,
 *    which is a list and not a canvas. The canvas pans and *Fit* frames it, so
 *    running wider than the window costs nothing; a tall thin column costs
 *    everything below the fold.
 * 3. **Roughly the shape of a screen**, so that twenty small cards spread out
 *    instead of forming a two-thousand-pixel ribbon.
 */
export function shelfWidth(
  boxes: readonly SizedBox[],
  viewportWidth: number,
  gap: number,
  aspect = 1.7,
): number {
  if (boxes.length === 0) return Math.max(1, viewportWidth);
  let area = 0;
  let widest = 0;
  for (const box of boxes) {
    area += (box.width + gap) * (box.height + gap);
    if (box.width > widest) widest = box.width;
  }
  const sideBySide = boxes.length > 1 ? widest * 2 + gap : widest;
  return Math.max(sideBySide, viewportWidth, Math.sqrt(area * aspect));
}

/**
 * Shelf packing, width first. Order is preserved: the canvas is a monitor, and
 * a session must not change places because an unrelated one grew a subagent.
 */
export function packShelves(boxes: readonly SizedBox[], spec: PackSpec): PackResult {
  const placements: Placement[] = [];
  const limit = Math.max(1, spec.shelfWidth);
  let x = 0;
  let shelfTop = 0;
  let shelfHeight = 0;

  for (const box of boxes) {
    if (x > 0 && x + box.width > limit) {
      shelfTop += shelfHeight + spec.gap;
      shelfHeight = 0;
      x = 0;
    }
    placements.push({ id: box.id, x, y: shelfTop, width: box.width, height: box.height });
    shelfHeight = Math.max(shelfHeight, box.height);
    x += box.width + spec.gap;
  }

  return { placements, bounds: boundsOfPlacements(placements) };
}

/**
 * The first corner where `box` fits without touching anything already placed.
 *
 * Candidates are the origin and the outer corners of every placed card, which
 * is the standard bottom-left heuristic: sorted by y then x, the first one that
 * both fits inside the shelf width and collides with nothing wins. Fifty cards
 * make two and a half thousand tests, which is nothing, and the result is
 * stable — the same canvas gives the same answer every time.
 */
export function firstFreeSlot(
  placed: readonly Placement[],
  box: SizedBox,
  spec: PackSpec,
): { readonly x: number; readonly y: number } {
  const limit = Math.max(1, spec.shelfWidth);
  const origin = boundsOfPlacements(placed);
  const left = placed.length === 0 ? 0 : origin.minX;
  const top = placed.length === 0 ? 0 : origin.minY;

  const candidates: { x: number; y: number }[] = [{ x: left, y: top }];
  for (const one of placed) {
    candidates.push({ x: one.x + one.width + spec.gap, y: one.y });
    candidates.push({ x: left, y: one.y + one.height + spec.gap });
  }
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);

  for (const candidate of candidates) {
    if (candidate.x > left && candidate.x + box.width > left + limit) continue;
    const trial: Placement = { id: box.id, ...candidate, width: box.width, height: box.height };
    if (!placed.some((one) => overlaps(trial, one))) return candidate;
  }

  // Every corner was taken: start a fresh shelf under everything.
  return { x: left, y: placed.length === 0 ? top : origin.maxY + spec.gap };
}
