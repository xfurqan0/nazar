/**
 * N-WP17a: the `@alias` on a card is a **text node**, and it is only there when
 * the session says which machine it came from.
 *
 * Driven rather than grepped, for the reason `double.ts` gives: a source scan
 * would be satisfied by an element that is built and never shown, or by one
 * shown on every card. Both were real risks here — the label is `display: none`
 * by default and its `x` is computed from the title's width — so the renderer
 * is run and the resulting elements are counted.
 *
 * The "text node" half is the one that matters beyond layout. An ssh alias is
 * the one string on a card that Nazar puts there itself rather than reading out
 * of a file, and it still goes through `setText` like every other string on the
 * canvas: whatever it contains arrives as characters, not as markup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../catalogs.ts';
import { FakeElement, root } from './double.ts';
import type { SessionView } from '@nazar/core';
import { CARD, CanvasRenderer, TREE_SPEC } from '../../web/canvas.ts';
import { cardSize, layerTree } from '../../src/layout.ts';

const NOW = 1_788_000_000_000;

function session(extra: Partial<SessionView> = {}): SessionView {
  return {
    id: 'one',
    provider: 'claude',
    pid: 4242,
    cwd: '/home/x/app',
    status: 'busy',
    state: 'alive',
    source: 'files',
    lastSeenAt: NOW,
    agents: [],
    roots: [],
    orphans: [],
    treeRead: true,
    ...extra,
  } as SessionView;
}

/** Draw one session onto a detached root and hand back the tree. */
function draw(view: SessionView): FakeElement {
  const canvas = root();
  const renderer = new CanvasRenderer(canvas as never);
  const tree = layerTree([], TREE_SPEC);
  renderer.update(
    [view],
    new Map([[view.id, { id: view.id, tree, box: cardSize(tree, false, CARD), collapsed: false }]]),
    new Map([[view.id, { id: view.id, x: 0, y: 0, width: 300, height: 200 }]]),
    NOW,
  );
  return canvas;
}

test('a local card has a host label element and never shows it', () => {
  const card = draw(session());
  const labels = card.byClass('nz-session__host');
  assert.equal(labels.length, 1, 'the element exists on every card; it is positioned, not rebuilt');
  assert.equal(labels[0]?.attrs.get('display'), 'none');
  assert.equal(labels[0]?.textContent, '');
});

test('a remote card shows @alias, as text and nothing else', () => {
  const card = draw(session({ host: 'buildbox' }));
  const label = card.byClass('nz-session__host')[0];
  assert.ok(label !== undefined);
  assert.equal(label.attrs.get('display'), 'inline');
  assert.equal(label.textContent, '@buildbox');
  // The element the alias lands in is an SVG `<text>`, so there is no markup
  // path for it to take even if a name somehow carried one.
  assert.equal(label.tag, 'text');
});

test('the label sits after the title rather than under it', () => {
  const short = draw(session({ cwd: '/a/b', host: 'box' }));
  const long = draw(session({ cwd: '/a/a-very-long-project-directory-name', host: 'box' }));
  const x = (card: FakeElement): number =>
    Number(card.byClass('nz-session__host')[0]?.attrs.get('x') ?? '0');
  assert.ok(x(short) > 0);
  assert.ok(
    x(long) > x(short),
    'the alias follows the title, so a longer folder pushes it right rather than under it',
  );
});

test('the hover behind the label says which machine, and only names a drop when there is one', () => {
  const live = draw(session({ host: 'box' }));
  const liveNote = live.byClass('nz-session__host')[0]?.parent?.byTag('title');
  assert.equal(liveNote?.textContent, 'on box');

  // A dropped connection keeps its cards and goes quiet — `state: 'unknown'`,
  // exactly what a local session whose process stopped answering gets — so the
  // hover has to carry the one thing that tells the two apart.
  const dropped = draw(session({ host: 'box', state: 'unknown', lastSeenAt: NOW - 90_000 }));
  const droppedNote = dropped.byClass('nz-session__host')[0]?.parent?.byTag('title');
  assert.match(droppedNote?.textContent ?? '', /last seen/);
});
