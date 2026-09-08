/**
 * WP4e: what a right-click means, and the two places it must not mean anything.
 *
 * Suppressing the browser's context menu is a thing to be careful with, so the
 * rule is a pure function and this is where its edges are pinned. The two
 * `native` answers are the important ones: inside a note the browser's menu is
 * the only useful one (Cut, Paste, Undo, the spell-checker), and on a frozen
 * history tree every entry either menu could offer would be refused.
 *
 * The last test is the mapping test the brief asks for: it reads `app.ts` and
 * checks that the handler actually goes through this function and actually
 * calls `preventDefault` for the two answers that require it — a rule nothing
 * consults is decoration.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANVAS_MENU_ITEMS,
  contextActionOf,
  suppressesNativeMenu,
  type ContextAction,
} from '../src/contextmenu.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

test('a right-click on a card opens the card menu', () => {
  assert.equal(
    contextActionOf({ sessionId: 's1', inNote: false, frozen: false }),
    'card-menu' satisfies ContextAction,
  );
});

test('a right-click on the background opens the canvas menu', () => {
  assert.equal(contextActionOf({ inNote: false, frozen: false }), 'canvas-menu');
});

test('a right-click inside a note leaves the browser alone', () => {
  // A note is a text box, and the browser's menu is where Cut, Paste, Undo and
  // the spell-checker live. Three canvas commands would be a downgrade.
  assert.equal(contextActionOf({ inNote: true, frozen: false }), 'native');
  assert.equal(contextActionOf({ sessionId: 's1', inNote: true, frozen: false }), 'native');
});

test('a frozen tree leaves the browser alone too', () => {
  // History has no card menu (the ⋯ is not drawn), nothing to arrange, and no
  // tab for a note to live on. A menu of refusals is worse than no menu.
  assert.equal(contextActionOf({ sessionId: 's1', inNote: false, frozen: true }), 'native');
  assert.equal(contextActionOf({ inNote: false, frozen: true }), 'native');
});

test('exactly the two canvas answers suppress the native menu', () => {
  assert.equal(suppressesNativeMenu('card-menu'), true);
  assert.equal(suppressesNativeMenu('canvas-menu'), true);
  assert.equal(suppressesNativeMenu('native'), false);
});

test('the canvas menu offers the three things there are to do on empty canvas', () => {
  assert.deepEqual(
    CANVAS_MENU_ITEMS.map((item) => item.id),
    ['add-note', 'arrange', 'fit'],
  );
  // "here" is load-bearing: the entry places a note at the pointer, not
  // somewhere sensible, which is why the menu carries the point it opened on.
  assert.equal(CANVAS_MENU_ITEMS[0]?.labelKey, 'menu.addNoteHere');
});

test('the page routes its contextmenu through this rule and honours the answer', () => {
  const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
  assert.ok(app.includes("addEventListener('contextmenu'"), 'nothing listens for a right-click');
  assert.ok(app.includes('contextActionOf('), 'the handler decides for itself');

  const handler = app.slice(
    app.indexOf("host.addEventListener('contextmenu'"),
    app.indexOf("host.addEventListener('keydown'"),
  );
  assert.ok(handler.length > 0, 'the contextmenu handler moved');
  assert.ok(
    /if \(action === 'native'\) return;\s*\n\s*event\.preventDefault\(\);/.test(handler),
    'the native answer must return *before* preventDefault, and the other two after it',
  );
  assert.ok(handler.includes('openCardMenu('), 'a card right-click opens the card menu');
  assert.ok(handler.includes('canvasMenu.open('), 'a background right-click opens the canvas menu');

  // And the two menus are the same element kind, so the stylesheet has one rule.
  const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
  assert.ok(html.includes('id="cardmenu" class="nz-menu"'));
  assert.ok(html.includes('id="canvasmenu" class="nz-menu"'));
});
