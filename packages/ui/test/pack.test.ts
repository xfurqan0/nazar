/**
 * Where the cards go, and the complaint that produced this file: "I see all my
 * sessions stacked vertically."
 *
 * The old grid capped a card at however many columns fitted the browser window,
 * so a three-column card in a four-column window left one free column, every
 * following card wrapped, and the canvas became a list. These tests pin the two
 * properties that make it a canvas instead: the default fills the width before
 * it wraps, and nothing ever lands on top of anything.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  boundsOfPlacements,
  firstFreeSlot,
  overlaps,
  packShelves,
  shelfWidth,
  type Placement,
  type SizedBox,
} from '../src/pack.ts';

const box = (id: string, width: number, height: number): SizedBox => ({ id, width, height });

function assertNoOverlaps(placements: readonly Placement[]): void {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      if (a === undefined || b === undefined) continue;
      assert.equal(overlaps(a, b), false, `${a.id} overlaps ${b.id}`);
    }
  }
}

test('overlaps is about shared area, not about touching', () => {
  const a: Placement = { id: 'a', x: 0, y: 0, width: 100, height: 100 };
  assert.equal(overlaps(a, { id: 'b', x: 100, y: 0, width: 100, height: 100 }), false);
  assert.equal(overlaps(a, { id: 'b', x: 99, y: 0, width: 100, height: 100 }), true);
  assert.equal(overlaps(a, { id: 'b', x: 0, y: 100, width: 100, height: 100 }), false);
});

test('packShelves fills the width before it wraps', () => {
  const packed = packShelves(
    [box('a', 360, 400), box('b', 360, 300), box('c', 360, 200), box('d', 360, 100)],
    { shelfWidth: 1128, gap: 24 },
  );
  const [a, b, c, d] = packed.placements;

  assert.deepEqual([a?.x, a?.y], [0, 0]);
  assert.deepEqual([b?.x, b?.y], [384, 0], 'side by side, not underneath');
  assert.deepEqual([c?.x, c?.y], [768, 0]);
  assert.deepEqual([d?.x, d?.y], [0, 424], 'the fourth wraps under the tallest of row one');
  assertNoOverlaps(packed.placements);
});

test('packShelves keeps every card its own height', () => {
  const packed = packShelves([box('tall', 200, 400), box('short', 200, 120)], {
    shelfWidth: 1000,
    gap: 20,
  });
  assert.equal(packed.placements[0]?.height, 400);
  assert.equal(packed.placements[1]?.height, 120);
  assert.deepEqual(packed.bounds, { minX: 0, minY: 0, maxX: 420, maxY: 400 });
});

test('packShelves never overlaps, whatever the mix of sizes', () => {
  const boxes = Array.from({ length: 40 }, (_, i) =>
    box(`s${i}`, [360, 744, 1128][i % 3] ?? 360, 200 + ((i * 137) % 900)),
  );
  const packed = packShelves(boxes, { shelfWidth: 2400, gap: 24 });
  assert.equal(packed.placements.length, 40);
  assertNoOverlaps(packed.placements);
  assert.ok(packed.bounds.maxX <= 2400 + 1128, 'a lone oversize card is the only way past the shelf');
});

test('packShelves preserves order, so a session does not move because another grew', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const packed = packShelves(
    ids.map((id) => box(id, 300, 200)),
    { shelfWidth: 1000, gap: 20 },
  );
  assert.deepEqual(
    packed.placements.map((one) => one.id),
    ids,
  );
});

test('packShelves on nothing is an empty box, not a crash', () => {
  const packed = packShelves([], { shelfWidth: 800, gap: 10 });
  assert.deepEqual(packed.placements, []);
  assert.deepEqual(packed.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

/**
 * The shelf is at least as wide as the window — "fill the width first" — but is
 * also allowed to run wider, because three 1,128 px cards in a 1,600 px window
 * would otherwise be the vertical column the maintainer is complaining about.
 */
test('shelfWidth is at least the window and at least the widest card', () => {
  assert.equal(shelfWidth([], 1600, 24), 1600);
  assert.ok(shelfWidth([box('a', 2000, 400)], 800, 24) >= 2000);
  assert.ok(shelfWidth([box('a', 360, 400)], 1600, 24) >= 1600);
});

/** The complaint, as an assertion: two cards never stack when there are two. */
test('shelfWidth always fits two of the widest card side by side', () => {
  for (const [count, width, height, window] of [
    [2, 1128, 1418, 1484],
    [3, 1128, 686, 1484],
    [4, 1128, 2272, 1200],
    [9, 360, 400, 1000],
  ] as const) {
    const boxes = Array.from({ length: count }, (_, i) => box(`s${i}`, width, height));
    const shelf = shelfWidth(boxes, window, 24);
    assert.ok(
      shelf >= width * 2 + 24,
      `${count} cards of ${width}px in a ${window}px window get a ${shelf}px shelf`,
    );
    const packed = packShelves(boxes, { shelfWidth: shelf, gap: 24 });
    const firstRow = packed.placements.filter((one) => one.y === 0);
    assert.ok(firstRow.length >= 2, `${count}x${width} still stacked one per row`);
    assertNoOverlaps(packed.placements);
  }
});

test('shelfWidth widens a tall stack towards the shape of a screen', () => {
  const boxes = Array.from({ length: 12 }, (_, i) => box(`s${i}`, 360, 300));
  const width = shelfWidth(boxes, 800, 24);
  assert.ok(width > 800, `shelf is ${width}, no wider than a narrow window`);
  const packed = packShelves(boxes, { shelfWidth: width, gap: 24 });
  const rows = new Set(packed.placements.map((one) => one.y)).size;
  const columns = packed.placements.filter((one) => one.y === 0).length;
  assert.ok(Math.abs(rows - columns) <= 2, `${columns} x ${rows} is not screen-shaped`);
});

/* ------------------------------------------------------------------ *
 * firstFreeSlot
 * ------------------------------------------------------------------ */

test('firstFreeSlot puts the first card at the origin', () => {
  assert.deepEqual(firstFreeSlot([], box('a', 360, 300), { shelfWidth: 1000, gap: 24 }), {
    x: 0,
    y: 0,
  });
});

test('firstFreeSlot fills the row before it starts a new one', () => {
  const placed: Placement[] = [{ id: 'a', x: 0, y: 0, width: 360, height: 300 }];
  const next = firstFreeSlot(placed, box('b', 360, 300), { shelfWidth: 1000, gap: 24 });
  assert.deepEqual(next, { x: 384, y: 0 });
});

test('firstFreeSlot drops to a new row when the shelf is full', () => {
  const placed: Placement[] = [
    { id: 'a', x: 0, y: 0, width: 360, height: 300 },
    { id: 'b', x: 384, y: 0, width: 360, height: 500 },
  ];
  const next = firstFreeSlot(placed, box('c', 360, 200), { shelfWidth: 760, gap: 24 });
  assert.deepEqual(next, { x: 0, y: 324 }, 'under the first card, which is the higher corner');
});

test('firstFreeSlot never lands on an arranged card', () => {
  // The user has dragged three cards into a cluster; ten sessions then appear.
  let placed: Placement[] = [
    { id: 'x', x: -200, y: -100, width: 400, height: 300 },
    { id: 'y', x: 260, y: -100, width: 400, height: 600 },
    { id: 'z', x: -200, y: 260, width: 400, height: 300 },
  ];
  for (let i = 0; i < 10; i += 1) {
    const fresh = box(`n${i}`, 360, 250);
    const at = firstFreeSlot(placed, fresh, { shelfWidth: 1400, gap: 24 });
    placed = [...placed, { ...fresh, ...at }];
  }
  assert.equal(placed.length, 13);
  assertNoOverlaps(placed);
});

test('firstFreeSlot is stable: the same canvas gives the same answer', () => {
  const placed: Placement[] = [
    { id: 'a', x: 0, y: 0, width: 360, height: 300 },
    { id: 'b', x: 384, y: 0, width: 744, height: 420 },
  ];
  const spec = { shelfWidth: 1200, gap: 24 };
  const once = firstFreeSlot(placed, box('c', 360, 200), spec);
  const twice = firstFreeSlot(placed, box('c', 360, 200), spec);
  assert.deepEqual(once, twice);
});

test('boundsOfPlacements covers negative coordinates', () => {
  assert.deepEqual(
    boundsOfPlacements([
      { id: 'a', x: -50, y: -20, width: 100, height: 40 },
      { id: 'b', x: 200, y: 300, width: 100, height: 40 },
    ]),
    { minX: -50, minY: -20, maxX: 300, maxY: 340 },
  );
  assert.deepEqual(boundsOfPlacements([]), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});
