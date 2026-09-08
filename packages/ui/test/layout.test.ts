/**
 * The layout, and the one rule WP4c exists to enforce: **nothing a session card
 * draws is allowed outside the card**.
 *
 * The bug this file pins had two halves and both are asserted below. The tree
 * used to wrap only at the roots, and even then it skipped the first subtree in
 * a band, so one agent with twenty children produced a 3,424 px tree; and the
 * card used to be sized by however many columns fitted the *browser window*, so
 * a narrow window drew a 744 px card around a 1,016 px tree. Either half put
 * nodes and half-drawn connectors on the canvas outside their own frame.
 *
 * `assertInside` is the whole gate: it walks every node rectangle and every
 * connector vertex through the same arithmetic the renderer uses.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeDemoState } from '../src/demo.ts';
import {
  boundsOf,
  cardMinimum,
  cardSize,
  changesHeight,
  changesWidth,
  clampCardHeight,
  clampCardWidth,
  clampScale,
  columnsFor,
  edgePath,
  fitToBox,
  initialViewport,
  isCornerHandle,
  isResizeHandle,
  layerTree,
  MAX_SCALE,
  maxCardHeight,
  maxCardWidth,
  MIN_CARD_WIDTH,
  minCardHeight,
  MIN_SCALE,
  patternOffset,
  patternTransform,
  pullsNorth,
  pullsWest,
  RESIZE_HANDLES,
  resizeCard,
  screenToCanvas,
  treeMaxWidth,
  zoomAt,
  type CardSpec,
  type ResizeBounds,
  type ResizeBox,
  type TreeInput,
  type TreeLayout,
  type TreeSpec,
  type Viewport,
} from '../src/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

/** The real geometry, copied from `web/canvas.ts` so the numbers are the ones drawn. */
const CARD: CardSpec = {
  column: 360,
  gap: 24,
  pad: 16,
  headerHeight: 212,
  emptyTreeHeight: 10,
  collapsedHeight: 42,
  maxColumns: 3,
};
const REAL: TreeSpec = {
  nodeWidth: 156,
  nodeHeight: 92,
  hGap: 16,
  vGap: 30,
  maxWidth: treeMaxWidth(CARD),
};

const tree: TreeSpec = { nodeWidth: 100, nodeHeight: 50, hGap: 20, vGap: 30 };
const leaf = (id: string): TreeInput => ({ id, children: [] });
const node = (id: string, ...children: TreeInput[]): TreeInput => ({ id, children });

/**
 * Every node and every connector vertex, in card coordinates, with the card
 * sized the way the renderer sizes it.
 *
 * The edge stroke is 1.4 px wide, so half of it sits outside the geometric
 * line; a whole pixel of slack is subtracted from the padding to cover it.
 */
function assertInside(
  laid: TreeLayout,
  label: string,
  collapsed = false,
  width?: number,
): void {
  const box = cardSize(laid, collapsed, CARD, width === undefined ? {} : { width });
  const stroke = 1;
  const left = CARD.pad - stroke;
  const right = box.width - CARD.pad + stroke;
  const top = box.treeOriginY - stroke;
  const bottom = box.height - CARD.pad + stroke;

  for (const one of laid.nodes) {
    const x = box.treeOriginX + one.x;
    const y = box.treeOriginY + one.y;
    assert.ok(x >= left, `${label}: node ${one.id} starts at ${x}, left of ${left}`);
    assert.ok(
      x + one.width <= right,
      `${label}: node ${one.id} ends at ${x + one.width}, past ${right} (card ${box.width})`,
    );
    assert.ok(y >= top, `${label}: node ${one.id} is above the tree origin`);
    assert.ok(
      y + one.height <= bottom,
      `${label}: node ${one.id} ends at ${y + one.height}, past ${bottom} (card ${box.height})`,
    );
  }

  for (const edge of laid.edges) {
    for (const point of edge.points) {
      const x = box.treeOriginX + point.x;
      const y = box.treeOriginY + point.y;
      assert.ok(
        x >= left && x <= right,
        `${label}: connector ${edge.parentId}->${edge.childId} reaches x=${x}, outside [${left}, ${right}]`,
      );
      assert.ok(
        y >= top && y <= bottom,
        `${label}: connector ${edge.parentId}->${edge.childId} reaches y=${y}, outside [${top}, ${bottom}]`,
      );
    }
  }
}

/** Rectangles must not overlap, or the tree reads as a pile. */
function assertNoNodeOverlap(laid: TreeLayout, label: string): void {
  const nodes = [...laid.nodes];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (a === undefined || b === undefined) continue;
      const hit =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.equal(hit, false, `${label}: ${a.id} and ${b.id} overlap`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * layerTree
 * ------------------------------------------------------------------ */

test('layerTree lays leaves out in order and stacks depth downward', () => {
  const laid = layerTree([leaf('a'), leaf('b'), leaf('c')], tree);
  const byId = new Map(laid.nodes.map((one) => [one.id, one]));

  assert.equal(byId.get('a')?.x, 0);
  assert.equal(byId.get('b')?.x, 120);
  assert.equal(byId.get('c')?.x, 240);
  for (const id of ['a', 'b', 'c']) assert.equal(byId.get(id)?.y, 0);
  assert.equal(laid.width, 340, '3 * 120 minus the trailing gap');
  assert.equal(laid.height, 50);
  assert.equal(laid.maxDepth, 0);
  assert.equal(laid.edges.length, 0);
});

test('layerTree centres a parent over its children', () => {
  const laid = layerTree([node('root', leaf('l'), leaf('r'))], tree);
  const byId = new Map(laid.nodes.map((one) => [one.id, one]));

  assert.equal(byId.get('l')?.x, 0);
  assert.equal(byId.get('r')?.x, 120);
  assert.equal(byId.get('root')?.x, 60, 'halfway between its two children');
  assert.equal(byId.get('root')?.y, 0);
  assert.equal(byId.get('l')?.y, 80, 'one node height plus one vertical gap');
  assert.equal(byId.get('root')?.centerX, 110);
  assert.equal(byId.get('l')?.parentId, 'root');
  assert.equal(laid.maxDepth, 1);
  assert.equal(laid.height, 130);
});

test('layerTree handles depth 3, which is the deepest Claude Code writes', () => {
  const laid = layerTree([node('d1', node('d2', leaf('d3')))], tree);
  const byId = new Map(laid.nodes.map((one) => [one.id, one]));
  assert.equal(byId.get('d1')?.depth, 0);
  assert.equal(byId.get('d2')?.depth, 1);
  assert.equal(byId.get('d3')?.depth, 2);
  assert.equal(byId.get('d1')?.x, 0);
  assert.equal(byId.get('d2')?.x, 0);
  assert.equal(byId.get('d3')?.x, 0);
  assert.equal(laid.height, 3 * 80 - 30);
});

test('layerTree wraps roots onto a new band past maxWidth', () => {
  const laid = layerTree([leaf('a'), leaf('b'), leaf('c'), leaf('d')], { ...tree, maxWidth: 260 });
  const byId = new Map(laid.nodes.map((one) => [one.id, one]));

  assert.equal(byId.get('a')?.y, 0);
  assert.equal(byId.get('b')?.y, 0);
  assert.equal(byId.get('c')?.y, 80, 'the third root starts a second band');
  assert.equal(byId.get('c')?.x, 0);
  assert.equal(byId.get('d')?.x, 120);
  assert.equal(laid.width, 220, 'never wider than the two roots that fit');
  assert.equal(laid.height, 130);
});

/**
 * The regression. Before WP4c the wrap check was `bandX > 0 && ...`, so the
 * first subtree in a band was never wrapped however wide it was: one agent with
 * twenty children laid out 3,424 px of tree inside a 1,128 px card.
 */
test('layerTree wraps a single parent whose children do not fit', () => {
  const children = Array.from({ length: 20 }, (_, i) => leaf(`k${i}`));
  const laid = layerTree([node('boss', ...children)], { ...tree, maxWidth: 300 });

  assert.ok(laid.width <= 300, `tree is ${laid.width} wide, past the 300 cap`);
  assert.equal(laid.nodes.length, 21);
  assertNoNodeOverlap(laid, '20 children at cap 300');

  const rows = new Set(laid.nodes.filter((one) => one.depth === 1).map((one) => one.y));
  assert.ok(rows.size > 1, 'the children wrapped onto several rows');
});

test('layerTree keeps a wrapped tree inside maxWidth at every depth', () => {
  const grandchildren = (n: number): TreeInput[] =>
    Array.from({ length: n }, (_, i) => leaf(`g${n}-${i}`));
  const laid = layerTree(
    [
      node('a', node('a1', ...grandchildren(9)), node('a2', ...grandchildren(7))),
      node('b', ...grandchildren(12)),
      leaf('c'),
    ],
    REAL,
  );

  assert.ok(
    laid.width <= (REAL.maxWidth ?? Number.POSITIVE_INFINITY),
    `tree is ${laid.width} wide, past ${REAL.maxWidth}`,
  );
  assertNoNodeOverlap(laid, 'deep wrapped tree');
  assertInside(laid, 'deep wrapped tree');
});

test('layerTree survives a repeated id instead of looping forever', () => {
  const shared = leaf('same');
  const laid = layerTree([node('root', shared, shared)], tree);
  assert.equal(laid.nodes.length, 2);
  assert.equal(laid.nodes.filter((one) => one.id === 'same').length, 1);
});

test('layerTree on an empty forest is an empty box', () => {
  const laid = layerTree([], tree);
  assert.deepEqual(laid.nodes, []);
  assert.deepEqual(laid.edges, []);
  assert.equal(laid.width, 0);
  assert.equal(laid.height, 0);
  assert.deepEqual(laid.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

test('every connector is an unbroken axis-aligned polyline', () => {
  const laid = layerTree(
    [node('boss', ...Array.from({ length: 14 }, (_, i) => leaf(`k${i}`)))],
    REAL,
  );
  assert.equal(laid.edges.length, 14);
  for (const edge of laid.edges) {
    assert.ok(edge.points.length >= 4, 'a connector needs at least four vertices');
    for (let i = 1; i < edge.points.length; i += 1) {
      const from = edge.points[i - 1];
      const to = edge.points[i];
      assert.ok(from !== undefined && to !== undefined);
      assert.ok(
        from.x === to.x || from.y === to.y,
        `segment ${i} of ${edge.parentId}->${edge.childId} is diagonal`,
      );
    }
    // It must actually reach both ends, or the maintainer's "lines are cut".
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    const parent = laid.nodes.find((one) => one.id === edge.parentId);
    const child = laid.nodes.find((one) => one.id === edge.childId);
    assert.ok(parent !== undefined && child !== undefined && first !== undefined && last !== undefined);
    assert.equal(first.x, parent.centerX);
    assert.equal(first.y, parent.y + parent.height);
    assert.equal(last.x, child.centerX);
    assert.equal(last.y, child.y);
  }
  assert.match(edgePath(laid.edges[0]!), /^M [-\d.]+ [-\d.]+( L [-\d.]+ [-\d.]+)+$/);
});

/* ------------------------------------------------------------------ *
 * Nothing outside the card
 * ------------------------------------------------------------------ */

/** The fixture forest, hung together by `parentAgentId` the way the core does. */
function fixtureForest(): TreeInput[] {
  const dir = path.join(fixtures, 'subagents');
  const metas = readdirSync(dir)
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => {
      const raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as {
        parentAgentId?: string;
      };
      return { id: name.replace(/^agent-|\.meta\.json$/g, ''), parent: raw.parentAgentId };
    });

  const ids = new Set(metas.map((one) => one.id));
  const build = (id: string): TreeInput => ({
    id,
    children: metas.filter((one) => one.parent === id).map((one) => build(one.id)),
  });
  return metas
    .filter((one) => one.parent === undefined || !ids.has(one.parent))
    .map((one) => build(one.id));
}

test('the real fixture tree fits inside its card', () => {
  const forest = fixtureForest();
  assert.equal(forest.length, 4, 'four roots in fixtures/subagents');
  const laid = layerTree(forest, REAL);
  assert.equal(laid.nodes.length, 7);
  assert.equal(laid.maxDepth, 2, 'depth 3 as Claude Code numbers it');
  assertInside(laid, 'fixtures/subagents');
  assertNoNodeOverlap(laid, 'fixtures/subagents');
});

test('a synthetic 60-agent session fits inside its card', () => {
  const state = makeDemoState({ now: 1_788_756_000_000, sessions: 1, agentsPerSession: 54 });
  const session = state.sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.agents.length, 60);

  const toInput = (nodes: typeof session.roots): TreeInput[] =>
    nodes.map((one) => ({ id: one.agent.id, children: toInput(one.children) }));
  const laid = layerTree(toInput(session.roots), REAL);

  assert.equal(laid.nodes.length, 60);
  assert.ok(laid.width <= (REAL.maxWidth ?? 0), `60-agent tree is ${laid.width} wide`);
  assertInside(laid, '60 agents');
  assertNoNodeOverlap(laid, '60 agents');
});

test('every demo canvas fits inside its cards, at every size', () => {
  for (const sessions of [1, 3, 9]) {
    for (const agents of [0, 6, 24, 54]) {
      const state = makeDemoState({ now: 1_788_756_000_000, sessions, agentsPerSession: agents });
      for (const session of state.sessions) {
        const toInput = (nodes: typeof session.roots): TreeInput[] =>
          nodes.map((one) => ({ id: one.agent.id, children: toInput(one.children) }));
        const laid = layerTree(toInput(session.roots), REAL);
        assertInside(laid, `${sessions}x${agents} ${session.id}`);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * cardSize
 * ------------------------------------------------------------------ */

test('columnsFor rounds a content width up to whole columns, capped', () => {
  assert.equal(columnsFor(100, CARD), 1);
  assert.equal(columnsFor(360, CARD), 1);
  assert.equal(columnsFor(361, CARD), 2);
  assert.equal(columnsFor(744, CARD), 2, '360 + 24 + 360 is exactly two columns');
  assert.equal(columnsFor(745, CARD), 3);
  assert.equal(columnsFor(99_999, CARD), 3, 'never wider than the cap');
});

test('columnsFor rejects a card grid that cannot exist', () => {
  assert.throws(() => columnsFor(10, { ...CARD, maxColumns: 0 }), RangeError);
  assert.throws(() => columnsFor(10, { ...CARD, column: 0 }), RangeError);
});

/**
 * The other half of the bug: the card's width used to come from the browser
 * window. A tree is the same size on a phone and on a wall, so its card has to
 * be too — otherwise a narrow window redraws the same session too small for
 * itself.
 */
test('a card is sized by its tree and never by the window', () => {
  const laid = layerTree(
    Array.from({ length: 30 }, (_, i) => leaf(`a${i}`)),
    REAL,
  );
  const box = cardSize(laid, false, CARD);
  assert.equal(box.columns, 3);
  assert.equal(box.width, 3 * 360 + 2 * 24);
  assert.ok(box.innerWidth >= laid.width, 'the tree fits between the paddings');
  assert.equal(box.treeOriginY, CARD.headerHeight);
  assert.equal(box.height, CARD.headerHeight + laid.height + CARD.pad);
});

test('a session with no subagents gets a one-column card', () => {
  const box = cardSize(layerTree([], REAL), false, CARD);
  assert.equal(box.width, CARD.column);
  assert.equal(box.height, CARD.headerHeight + CARD.emptyTreeHeight);
});

test('a folded card is one column tall enough for its summary chips', () => {
  const laid = layerTree(
    Array.from({ length: 60 }, (_, i) => leaf(`a${i}`)),
    REAL,
  );
  const box = cardSize(laid, true, CARD);
  assert.equal(box.width, CARD.column, 'folding a tree away frees the columns it needed');
  assert.equal(box.height, CARD.headerHeight + CARD.collapsedHeight);
});

test('boundsOf is a zero box on nothing and a hull otherwise', () => {
  assert.deepEqual(boundsOf([]), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.deepEqual(boundsOf([{ x: 3, y: -2 }, { x: -1, y: 8 }]), {
    minX: -1,
    minY: -2,
    maxX: 3,
    maxY: 8,
  });
});

/* ------------------------------------------------------------------ *
 * pan and zoom
 * ------------------------------------------------------------------ */

test('clampScale holds the wheel inside the documented range', () => {
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(99), MAX_SCALE);
  assert.equal(clampScale(1.5), 1.5);
  assert.equal(clampScale(Number.NaN), MIN_SCALE);
});

test('zoomAt keeps the point under the cursor exactly where it is', () => {
  const before = { x: 40, y: -15, scale: 1 };
  const point = { x: 300, y: 220 };
  const canvasBefore = screenToCanvas(before, point.x, point.y);

  const after = zoomAt(before, 1.7, point.x, point.y);
  const canvasAfter = screenToCanvas(after, point.x, point.y);

  assert.ok(after.scale > before.scale);
  assert.ok(Math.abs(canvasBefore.x - canvasAfter.x) < 1e-9);
  assert.ok(Math.abs(canvasBefore.y - canvasAfter.y) < 1e-9);
});

test('zoomAt returns the same viewport once it is pinned at a limit', () => {
  const pinned = { x: 0, y: 0, scale: MAX_SCALE };
  assert.equal(zoomAt(pinned, 2, 10, 10), pinned);
  const floored = { x: 0, y: 0, scale: MIN_SCALE };
  assert.equal(zoomAt(floored, 0.5, 10, 10), floored);
});

test('fitToBox never scales up and centres what it shrinks', () => {
  const view = fitToBox({ minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, { width: 1000, height: 800 }, 20);
  assert.ok(view.scale < 1);
  assert.ok(view.scale >= MIN_SCALE);
  const centre = 1000 / 2 - (2000 * view.scale) / 2;
  assert.ok(Math.abs(view.x - centre) < 1e-9);

  const small = fitToBox({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { width: 1000, height: 800 }, 20);
  assert.equal(small.scale, 1, 'a small canvas is not blown up');
});

/** Cards can be dragged to negative coordinates, so fit has to know where they are. */
test('fitToBox frames content that does not start at the origin', () => {
  const shifted = fitToBox(
    { minX: -600, minY: -400, maxX: -200, maxY: -100 },
    { width: 1000, height: 800 },
    20,
  );
  const left = shifted.x + -600 * shifted.scale;
  const right = shifted.x + -200 * shifted.scale;
  assert.ok(left >= 0 && right <= 1000, `content lands at [${left}, ${right}], off screen`);
});

test('fitToBox on nothing does not divide by zero', () => {
  assert.deepEqual(
    fitToBox({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { width: 800, height: 600 }, 16),
    { x: 16, y: 16, scale: 1 },
  );
});

test('initialViewport opens at full size and only shrinks to fit the width', () => {
  const wide = initialViewport(
    { minX: 0, minY: 0, maxX: 2000, maxY: 4000 },
    { width: 1000, height: 800 },
    20,
  );
  assert.ok(wide.scale < 1, 'content wider than the window is scaled down');
  assert.equal(wide.y, 20, 'and pinned to the top rather than centred');

  const tall = initialViewport(
    { minX: 0, minY: 0, maxX: 400, maxY: 4000 },
    { width: 1000, height: 800 },
    20,
  );
  assert.equal(tall.scale, 1, 'a tall canvas stays readable and is panned instead');
  assert.equal(tall.x, 300, 'centred horizontally');

  assert.deepEqual(
    initialViewport({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { width: 800, height: 600 }, 16),
    { x: 16, y: 16, scale: 1 },
  );
});

/* ------------------------------------------------------------------ *
 * WP4f: a width the user dragged to
 *
 * The card's width is the tree's wrapping budget, so a resize is a re-layout
 * and not a scale. Everything below is one of the two halves of that: the
 * containment rule has to survive an arbitrary width, and the minimum offered
 * to the pointer has to be the width at which containment is still true.
 * ------------------------------------------------------------------ */

/** The tree of a demo session, as `layerTree` wants it. */
function demoForest(agentsPerSession: number): TreeInput[] {
  const state = makeDemoState({ now: 1_788_756_000_000, sessions: 1, agentsPerSession });
  const session = state.sessions[0];
  assert.ok(session !== undefined);
  const toInput = (nodes: typeof session.roots): TreeInput[] =>
    nodes.map((one) => ({ id: one.agent.id, children: toInput(one.children) }));
  return toInput(session.roots);
}

test('a card sized to an explicit width is that wide, unsnapped', () => {
  const laid = layerTree([leaf('a'), leaf('b')], REAL);
  const box = cardSize(laid, false, CARD, { width: 517 });
  assert.equal(box.width, 517, 'no column snap once the user has said a number');
  assert.equal(box.innerWidth, 517 - CARD.pad * 2);
  assert.equal(box.treeOriginY, CARD.headerHeight);
});

test('an explicit width still contains its tree, at every width', () => {
  const forest = demoForest(54);
  for (const width of [MIN_CARD_WIDTH, 360, 517, 744, 1128, maxCardWidth(CARD)]) {
    const laid = layerTree(forest, { ...REAL, maxWidth: width - CARD.pad * 2 });
    assert.ok(
      laid.width <= width - CARD.pad * 2,
      `a ${width} px card wrapped its tree at ${laid.width}`,
    );
    assertInside(laid, `60 agents at ${width}`, false, width);
    assertNoNodeOverlap(laid, `60 agents at ${width}`);
  }
});

test('the minimum width is the narrowest layout the tree has, not a guess', () => {
  const forest = demoForest(54);
  const min = cardMinimum(forest, false, REAL, CARD);

  // One subtree per row. The tree is then one node wide, plus the trunk lane a
  // wrapped level reserves on its left — one gap per level of nesting, and
  // nothing else — so the whole sixty-agent forest is narrower than one column.
  assert.ok(
    min.tree.width <= REAL.nodeWidth + REAL.hGap * (min.tree.maxDepth + 1),
    `narrowest sixty-agent tree is ${min.tree.width}; a node is ${REAL.nodeWidth}`,
  );
  assert.equal(min.width, Math.max(MIN_CARD_WIDTH, min.tree.width + CARD.pad * 2));
  assert.equal(min.width, MIN_CARD_WIDTH, 'a node and its lanes fit under the readability floor');

  // And it is a real minimum: at that width the tree still fits, and what stops
  // it going lower is the floor rather than a number somebody picked.
  const laid = layerTree(forest, { ...REAL, maxWidth: min.width - CARD.pad * 2 });
  assertInside(laid, 'sixty agents at the minimum', false, min.width);
  assertNoNodeOverlap(laid, 'sixty agents at the minimum');
});

test('the minimum height is the tree standing on end', () => {
  const forest = demoForest(54);
  const min = cardMinimum(forest, false, REAL, CARD);
  const wide = cardSize(layerTree(forest, REAL), false, CARD);
  assert.ok(
    min.height > wide.height * 3,
    `narrowest is ${min.height} tall and widest ${wide.height}; the trade should be steep`,
  );
  assert.equal(min.height, CARD.headerHeight + min.tree.height + CARD.pad);
});

test('a wide subtree does not stop the card from being narrow', () => {
  // One root with twenty children is the shape that broke WP4c. Narrowed, the
  // children stack under it rather than the card refusing to shrink.
  const forest = [node('root', ...Array.from({ length: 20 }, (_, i) => leaf(`c${i}`)))];
  const min = cardMinimum(forest, false, REAL, CARD);
  assert.equal(min.width, MIN_CARD_WIDTH);
  const laid = layerTree(forest, { ...REAL, maxWidth: min.width - CARD.pad * 2 });
  assert.equal(laid.nodes.length, 21);
  assertInside(laid, 'twenty children, narrowed', false, min.width);
  assertNoNodeOverlap(laid, 'twenty children, narrowed');
});

test('hiding the tree drops the minimum to the floor', () => {
  const forest = demoForest(54);
  const open = cardMinimum(forest, false, REAL, CARD);
  const folded = cardMinimum(forest, true, REAL, CARD);
  const cleared = cardMinimum([], false, REAL, CARD);

  assert.equal(folded.width, MIN_CARD_WIDTH);
  assert.equal(folded.height, CARD.headerHeight + CARD.collapsedHeight);
  assert.ok(folded.height < open.height, 'folding a tree away frees its height');
  assert.equal(cleared.width, MIN_CARD_WIDTH);
  assert.equal(cleared.height, CARD.headerHeight + CARD.emptyTreeHeight);
});

test('the real fixture tree has a minimum that contains it', () => {
  const forest = fixtureForest();
  const min = cardMinimum(forest, false, REAL, CARD);
  const laid = layerTree(forest, { ...REAL, maxWidth: min.width - CARD.pad * 2 });
  assert.equal(laid.nodes.length, 7, 'nothing is dropped by narrowing');
  assertInside(laid, 'fixtures/subagents, narrowed', false, min.width);
  assertNoNodeOverlap(laid, 'fixtures/subagents, narrowed');
});

test('clampCardWidth holds a dragged width between the tree and the ceiling', () => {
  const min = 420;
  assert.equal(clampCardWidth(500, min, CARD), 500);
  assert.equal(clampCardWidth(10, min, CARD), min, 'never under the tree that is showing');
  assert.equal(clampCardWidth(-4000, min, CARD), min);
  assert.equal(clampCardWidth(1e9, min, CARD), maxCardWidth(CARD));
  assert.equal(clampCardWidth(Number.NaN, min, CARD), min);
  assert.equal(clampCardWidth(517.4, min, CARD), 517, 'whole pixels reach storage');
  // The floor wins over a minimum somebody hand-edited below it.
  assert.equal(clampCardWidth(100, 10, CARD), MIN_CARD_WIDTH);
});

/* ------------------------------------------------------------------ *
 * N-WP10: eight handles — one axis each on the edges, a ratio on the
 * corners
 * ------------------------------------------------------------------ */

/** A card at (100, 200), 400 wide and 300 tall: a 4:3 box with room either way. */
const START: ResizeBox = { x: 100, y: 200, width: 400, height: 300 };

/** Bounds wide enough that a test which is not about clamping never meets one. */
const LOOSE: ResizeBounds = { minWidth: 100, maxWidth: 4000, minHeight: 100, maxHeight: 4000 };

const ratioOf = (box: { readonly width: number; readonly height: number }): number =>
  box.width / box.height;

test('the eight handles are named once and answer about themselves', () => {
  assert.deepEqual([...RESIZE_HANDLES], ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']);
  assert.equal(new Set(RESIZE_HANDLES).size, 8, 'a handle is listed twice');
  for (const handle of RESIZE_HANDLES) assert.ok(isResizeHandle(handle));
  assert.ok(!isResizeHandle('ne '), 'a stray attribute value would start a resize');
  assert.ok(!isResizeHandle('middle'));

  assert.deepEqual(RESIZE_HANDLES.filter(isCornerHandle), ['nw', 'ne', 'sw', 'se']);
  assert.deepEqual(RESIZE_HANDLES.filter(pullsWest), ['w', 'nw', 'sw']);
  assert.deepEqual(RESIZE_HANDLES.filter(pullsNorth), ['n', 'nw', 'ne']);
  // Exactly two handles leave each axis alone, and they are the opposite pair.
  assert.deepEqual(
    RESIZE_HANDLES.filter((one) => !changesWidth(one)),
    ['n', 's'],
  );
  assert.deepEqual(
    RESIZE_HANDLES.filter((one) => !changesHeight(one)),
    ['w', 'e'],
  );
});

test('the east and west edges change the width and nothing else', () => {
  const east = resizeCard('e', START, 60, -40, LOOSE);
  assert.equal(east.width, 460, 'the pointer distance, to the pixel');
  assert.equal(east.height, START.height, 'a vertical wobble must not change the height');
  assert.equal(east.x, START.x, 'the west edge holds, so the card does not move');
  assert.equal(east.y, START.y);

  // Pulling west grows the card leftwards: the *east* edge is the one that holds.
  const west = resizeCard('w', START, -60, 25, LOOSE);
  assert.equal(west.width, 460);
  assert.equal(west.height, START.height);
  assert.equal(west.x, 40, 'x walks back by exactly what the width gained');
  assert.equal(west.x + west.width, START.x + START.width, 'the right edge moved');
});

test('the north and south edges change the height and nothing else', () => {
  const south = resizeCard('s', START, 90, 45, LOOSE);
  assert.equal(south.height, 345);
  assert.equal(south.width, START.width, 'a horizontal wobble must not change the width');
  assert.equal(south.y, START.y, 'the top edge holds');

  const north = resizeCard('n', START, -12, -45, LOOSE);
  assert.equal(north.height, 345);
  assert.equal(north.width, START.width);
  assert.equal(north.y, 155, 'y walks back by exactly what the height gained');
  assert.equal(north.y + north.height, START.y + START.height, 'the bottom edge held');
});

test('a corner keeps the ratio it started with, whichever way the pointer went', () => {
  const before = ratioOf(START);
  for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
    for (const [dx, dy] of [
      [120, 90],
      [-120, -90],
      [200, 0],
      [0, -160],
      [-70, 210],
      [340, -55],
    ] as const) {
      const box = resizeCard(handle, START, dx, dy, LOOSE);
      assert.ok(
        Math.abs(ratioOf(box) - before) < 0.01,
        `${handle} at (${dx}, ${dy}) came out ${box.width}x${box.height}`,
      );
    }
  }
});

test('a corner dragged along its own diagonal follows the pointer exactly', () => {
  // The scale is the pointer projected onto the diagonal the card started with,
  // and the projection of a vector onto itself is itself: travel out along
  // (width, height) halved and the box comes back half again as big.
  const grown = resizeCard('se', START, START.width / 2, START.height / 2, LOOSE);
  assert.equal(grown.width, 600);
  assert.equal(grown.height, 450);
  // And back down the same line.
  const shrunk = resizeCard('se', START, -START.width / 2, -START.height / 2, LOOSE);
  assert.equal(shrunk.width, 200);
  assert.equal(shrunk.height, 150);
});

test('a corner is continuous across the line a dominant-axis rule would switch on', () => {
  // The reason the rule is a projection: 45 degrees is where "whichever axis
  // moved more" flips, and a card that jumps because a hand wobbled across that
  // line is the thing this avoids.
  const under = resizeCard('se', START, 99, 101, LOOSE);
  const over = resizeCard('se', START, 101, 99, LOOSE);
  assert.ok(Math.abs(under.width - over.width) <= 2, 'the corner jumps across 45 degrees');
  assert.ok(Math.abs(under.height - over.height) <= 2);
});

test('the corner opposite the one being dragged stays exactly where it was', () => {
  const right = START.x + START.width;
  const bottom = START.y + START.height;

  const nw = resizeCard('nw', START, -80, -60, LOOSE);
  assert.equal(nw.x + nw.width, right, 'the east edge moved under a nw drag');
  assert.equal(nw.y + nw.height, bottom, 'the south edge moved under a nw drag');

  const ne = resizeCard('ne', START, 80, -60, LOOSE);
  assert.equal(ne.x, START.x, 'the west edge moved under a ne drag');
  assert.equal(ne.y + ne.height, bottom);

  const sw = resizeCard('sw', START, -80, 60, LOOSE);
  assert.equal(sw.x + sw.width, right);
  assert.equal(sw.y, START.y);

  const se = resizeCard('se', START, 80, 60, LOOSE);
  assert.equal(se.x, START.x);
  assert.equal(se.y, START.y);
});

test('an edge stops at its own bound and leaves the other axis alone', () => {
  const bounds: ResizeBounds = { minWidth: 300, maxWidth: 500, minHeight: 250, maxHeight: 400 };
  assert.equal(resizeCard('e', START, -1e6, 0, bounds).width, 300);
  assert.equal(resizeCard('e', START, 1e6, 0, bounds).width, 500);
  assert.equal(resizeCard('e', START, 1e6, 0, bounds).height, START.height);
  assert.equal(resizeCard('s', START, 0, -1e6, bounds).height, 250);
  assert.equal(resizeCard('s', START, 0, 1e6, bounds).height, 400);
  assert.equal(resizeCard('s', START, 0, 1e6, bounds).width, START.width);
  // A west drag held at the floor still keeps its east edge where it was.
  const squashed = resizeCard('w', START, 1e6, 0, bounds);
  assert.equal(squashed.width, 300);
  assert.equal(squashed.x + squashed.width, START.x + START.width);
});

test('a corner that hits a bound stops both axes together, so the ratio holds', () => {
  const before = ratioOf(START);
  // The width ceiling bites first (500/400 = 1.25 against 900/300 = 3), so the
  // height has to stop at 1.25x as well rather than running to its own ceiling.
  const wide: ResizeBounds = { minWidth: 100, maxWidth: 500, minHeight: 100, maxHeight: 900 };
  const grown = resizeCard('se', START, 1e6, 1e6, wide);
  assert.equal(grown.width, 500);
  assert.equal(grown.height, 375, 'the height ran past the ratio to its own ceiling');
  assert.ok(Math.abs(ratioOf(grown) - before) < 0.01);

  // The same the other way: here the *height* floor binds (250/300 = 0.833
  // against 120/400 = 0.3), so the width has to stop at 0.833x too.
  const tight: ResizeBounds = { minWidth: 120, maxWidth: 4000, minHeight: 250, maxHeight: 4000 };
  const shrunk = resizeCard('nw', START, 1e6, 1e6, tight);
  assert.equal(shrunk.height, 250);
  assert.ok(Math.abs(shrunk.width - 333) <= 1, `width came out ${shrunk.width}`);
  assert.ok(Math.abs(ratioOf(shrunk) - before) < 0.01);
  // Clamped or not, the corner opposite the one dragged is still the fixed one.
  assert.equal(shrunk.x + shrunk.width, START.x + START.width);
  assert.equal(shrunk.y + shrunk.height, START.y + START.height);
});

test('a resize writes whole pixels and survives a pointer that reports nothing', () => {
  const box = resizeCard('se', START, 33.7, 20.2, LOOSE);
  assert.equal(box.width, Math.round(box.width));
  assert.equal(box.height, Math.round(box.height));
  assert.equal(box.x, Math.round(box.x));
  assert.equal(box.y, Math.round(box.y));
  // A NaN delta is a pointer event with nothing in it, not a reason to lose a card.
  assert.deepEqual(resizeCard('se', START, Number.NaN, Number.NaN, LOOSE), START);
  assert.deepEqual(resizeCard('n', START, 0, Number.NaN, LOOSE), START);
});

test('a minimum wins over a maximum a caller has put underneath it', () => {
  // Containment is a rule; a ceiling is only good manners.
  const upside: ResizeBounds = { minWidth: 600, maxWidth: 200, minHeight: 500, maxHeight: 150 };
  const box = resizeCard('se', START, -1e6, -1e6, upside);
  assert.ok(box.width >= 600, `width came out ${box.width}`);
  assert.ok(box.height >= 500, `height came out ${box.height}`);
});

/* ------------------------------------------------------------------ *
 * N-WP10: a dragged height is a floor under the tree, never a value
 * in place of it
 * ------------------------------------------------------------------ */

test('clampCardHeight holds a dragged height between the card and the ceiling', () => {
  const min = 400;
  assert.equal(clampCardHeight(500, min, CARD), 500);
  assert.equal(clampCardHeight(10, min, CARD), min, 'never under what the card is showing');
  assert.equal(clampCardHeight(-4000, min, CARD), min);
  assert.equal(clampCardHeight(1e9, min, CARD), maxCardHeight(CARD));
  assert.equal(clampCardHeight(Number.NaN, min, CARD), min);
  assert.equal(clampCardHeight(517.4, min, CARD), 517, 'whole pixels reach storage');
  // The absolute floor wins over a minimum somebody hand-edited below it.
  assert.equal(clampCardHeight(100, 10, CARD), minCardHeight(CARD));
  assert.equal(minCardHeight(CARD), CARD.headerHeight + CARD.emptyTreeHeight);
});

test('a card is drawn at the taller of its contents and the height dragged to', () => {
  const laid = layerTree(fixtureForest(), { ...REAL, maxWidth: 744 - CARD.pad * 2 });
  const auto = cardSize(laid, false, CARD, { width: 744 });
  assert.equal(auto.height, auto.contentHeight, 'an unsized card is exactly its contents');

  // Taller is allowed: the room shows up under the tree, empty.
  const taller = cardSize(laid, false, CARD, { width: 744, height: auto.contentHeight + 240 });
  assert.equal(taller.height, auto.contentHeight + 240);
  assert.equal(taller.contentHeight, auto.contentHeight, 'the floor is not the value');

  // Shorter is not: a height under the tree would put nodes outside their own
  // frame, which is the WP4c bug on the other axis.
  const shorter = cardSize(laid, false, CARD, { width: 744, height: 40 });
  assert.equal(shorter.height, auto.contentHeight, 'a card was let hide its own tree');
  assert.equal(cardSize(laid, false, CARD, { width: 744, height: 1e9 }).height, maxCardHeight(CARD));
  assert.equal(
    cardSize(laid, false, CARD, { width: 744, height: Number.NaN }).height,
    auto.contentHeight,
  );
});

test('a card dragged taller still contains its tree', () => {
  const laid = layerTree(fixtureForest(), { ...REAL, maxWidth: 744 - CARD.pad * 2 });
  const box = cardSize(laid, false, CARD, { width: 744, height: 1200 });
  assert.equal(box.height, 1200);
  // The containment rectangle only grew downwards; nothing moved and nothing
  // left it. `assertInside` measures against the *unsized* height, which is the
  // tighter of the two, so passing it there is the stronger statement.
  assertInside(laid, 'a card dragged taller', false, box.width);
  assert.ok(box.treeOriginY + laid.height <= box.height - CARD.pad);
});

/* ------------------------------------------------------------------ *
 * WP4f: the background pattern
 * ------------------------------------------------------------------ */

const TILE = 26;
const view = (x: number, y: number, scale = 1): Viewport => ({ x, y, scale });

test('the pattern offset follows the pan exactly, inside one tile', () => {
  assert.deepEqual(patternOffset(view(0, 0), TILE), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(patternOffset(view(10, 4), TILE), { x: 10, y: 4, scale: 1 });
  // Past a tile it wraps, and the wrap is exact: a pattern tiles with period
  // `tile * scale`, so shifting the origin by a whole period cannot move a dot.
  assert.deepEqual(patternOffset(view(26, 52), TILE), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(patternOffset(view(30, 27), TILE), { x: 4, y: 1, scale: 1 });
});

test('the pattern offset stays positive when the canvas is panned back', () => {
  // A negative modulo would put the tile grid a whole tile out of step, which
  // reads as the dots jumping the moment a pan crosses the origin.
  assert.deepEqual(patternOffset(view(-1, -1), TILE), { x: 25, y: 25, scale: 1 });
  assert.deepEqual(patternOffset(view(-26, -26), TILE), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(patternOffset(view(-30, -53), TILE), { x: 22, y: 25, scale: 1 });
});

test('the pattern tile scales with the zoom, and wraps at the scaled period', () => {
  assert.deepEqual(patternOffset(view(0, 0, 2), TILE), { x: 0, y: 0, scale: 2 });
  assert.deepEqual(patternOffset(view(52, 0, 2), TILE), { x: 0, y: 0, scale: 2 }, '26 * 2');
  assert.deepEqual(patternOffset(view(60, 0, 2), TILE), { x: 8, y: 0, scale: 2 });
  // At a quarter, one tile is 6.5 px and the offset wraps four times as often.
  assert.deepEqual(patternOffset(view(6.5, 0, 0.25), TILE), { x: 0, y: 0, scale: 0.25 });
  assert.deepEqual(patternOffset(view(7, 0, 0.25), TILE), { x: 0.5, y: 0, scale: 0.25 });
});

test('a whole number of tiles of pan is the same picture', () => {
  // The property the modulo rests on, checked rather than asserted in prose.
  for (const scale of [0.25, 1, 1.75, 3]) {
    const period = TILE * scale;
    for (const base of [0, 3.5, -11.25]) {
      for (const laps of [-3, 1, 40]) {
        assert.deepEqual(
          patternOffset(view(base + period * laps, 0, scale), TILE),
          patternOffset(view(base, 0, scale), TILE),
          `scale ${scale}, base ${base}, ${laps} tiles`,
        );
      }
    }
  }
});

test('a broken viewport does not produce a broken pattern', () => {
  assert.deepEqual(patternOffset(view(Number.NaN, 0), TILE), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(patternOffset(view(0, Number.POSITIVE_INFINITY), TILE), {
    x: 0,
    y: 0,
    scale: 1,
  });
  assert.deepEqual(patternOffset(view(10, 10, 0), TILE), { x: 10, y: 10, scale: 1 });
  assert.deepEqual(patternOffset(view(10, 10, Number.NaN), TILE), { x: 10, y: 10, scale: 1 });
});

test('the pattern transform is the attribute the renderer writes', () => {
  assert.equal(patternTransform(patternOffset(view(0, 0), TILE)), 'translate(0 0) scale(1)');
  assert.equal(patternTransform(patternOffset(view(30, 4, 1), TILE)), 'translate(4 4) scale(1)');
  // Two decimals, like every other coordinate this canvas writes.
  assert.equal(
    patternTransform({ x: 1.23456, y: -0.0001, scale: 0.33333 }),
    'translate(1.23 0) scale(0.33)',
  );
});
