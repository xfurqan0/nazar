/**
 * WP4e, N-WP14: what a right-click means, and the one place it must not mean
 * anything.
 *
 * Suppressing the browser's context menu is a thing to be careful with, so the
 * rule is a pure function and this is where its edges are pinned. The `native`
 * answer is the important one and there is now exactly one reason for it: a
 * text field, where the browser's menu holds Cut, Paste, Undo and the
 * spell-checker and no menu this application could draw holds any of them. A
 * sticky note counts as a text field only while it is the thing being typed
 * into — otherwise it is an object on a canvas with a menu of its own.
 *
 * The last two tests are mapping tests: they read `app.ts` and `web/notes.ts`
 * and check that the page actually goes through this function, actually calls
 * `preventDefault` for the answers that require it, and actually opens the
 * note's *existing* ⋯ menu at the pointer rather than a second copy of it. A
 * rule nothing consults is decoration.
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
  opensOwnMenu,
  suppressesNativeMenu,
  type ContextAction,
} from '../src/contextmenu.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

/** A pointer over the page chrome: the top bar, the drawer, the tab bar. */
const CHROME = { editable: false, onCanvas: false, frozen: false } as const;

/** A pointer over the canvas background. */
const CANVAS = { editable: false, onCanvas: true, frozen: false } as const;

test('a right-click on a card opens the card menu', () => {
  assert.equal(
    contextActionOf({ ...CANVAS, sessionId: 's1' }),
    'card-menu' satisfies ContextAction,
  );
});

test('a right-click on the background opens the canvas menu', () => {
  assert.equal(contextActionOf(CANVAS), 'canvas-menu');
});

test('the browser menu is gone everywhere on the page, and only a text field keeps it', () => {
  // (a) The whole point of N-WP14: a right-click on the top bar, the drawer or
  // the tab bar is prevented — there is nothing to offer there, but the
  // browser's menu is not this page's menu either.
  assert.equal(contextActionOf(CHROME), 'suppress');
  assert.equal(suppressesNativeMenu(contextActionOf(CHROME)), true);
  assert.equal(opensOwnMenu(contextActionOf(CHROME)), false, 'suppress opens nothing');

  // And the exception, which is the reason the rule can be trusted: an
  // `<input>`, a `<textarea>` or a `contenteditable` keeps its own menu, so
  // `defaultPrevented` there is false.
  for (const hit of [
    { ...CHROME, editable: true },
    { ...CANVAS, editable: true },
    { ...CANVAS, editable: true, sessionId: 's1' },
  ]) {
    assert.equal(contextActionOf(hit), 'native');
    assert.equal(suppressesNativeMenu(contextActionOf(hit)), false);
  }
});

test('a right-click on a note opens the note menu, at the pointer', () => {
  // (b) A note is an object on the canvas: the gesture reaches the menu the ⋯
  // button already opened, which is the same menu and the same element.
  const action = contextActionOf({ ...CANVAS, noteId: 'n1', editing: false });
  assert.equal(action, 'note-menu' satisfies ContextAction);
  assert.equal(suppressesNativeMenu(action), true);
  assert.equal(opensOwnMenu(action), true);
  // The note wins over the card underneath it, and over `editable`: the text
  // box is most of a note's area, and a note that could only be right-clicked
  // on its 18 px grip would be a gesture nobody finds.
  assert.equal(contextActionOf({ ...CANVAS, noteId: 'n1', editable: true }), 'note-menu');
  assert.equal(contextActionOf({ ...CANVAS, noteId: 'n1', sessionId: 's1' }), 'note-menu');
});

test('a note being typed into keeps the browser menu', () => {
  // (c) Editing is where Cut, Paste and the spell-checker are the only entries
  // worth having, and three canvas commands would be a downgrade. The caret is
  // what says the note is being edited, not the pointer.
  assert.equal(contextActionOf({ ...CANVAS, noteId: 'n1', editing: true }), 'native');
  assert.equal(
    suppressesNativeMenu(contextActionOf({ ...CANVAS, noteId: 'n1', editing: true })),
    false,
  );
});

test('a frozen tree offers nothing, and does not hand the browser its menu back', () => {
  // History has no card menu (the ⋯ is not drawn), nothing to arrange, and no
  // tab for a note to live on. A menu of refusals is worse than no menu — and
  // the browser's is still not this page's, so the press is prevented anyway.
  assert.equal(contextActionOf({ ...CANVAS, frozen: true, sessionId: 's1' }), 'suppress');
  assert.equal(contextActionOf({ ...CANVAS, frozen: true }), 'suppress');
});

test('exactly one answer leaves the native menu alone', () => {
  const every: readonly ContextAction[] = [
    'card-menu',
    'canvas-menu',
    'note-menu',
    'suppress',
    'native',
  ];
  assert.deepEqual(
    every.filter((action) => !suppressesNativeMenu(action)),
    ['native'],
  );
  assert.deepEqual(every.filter(opensOwnMenu), ['card-menu', 'canvas-menu', 'note-menu']);
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
  assert.ok(app.includes('contextActionOf('), 'the handler decides for itself');
  // On the document, not on the canvas host: the top bar, the drawer and the
  // tab bar are the places the second report was about.
  assert.ok(
    app.includes("document.addEventListener('contextmenu'"),
    'the right-click is claimed for the whole page, not just the canvas',
  );
  assert.equal(
    app.includes("host.addEventListener('contextmenu'"),
    false,
    'a second handler on the canvas would decide the same press twice',
  );

  const handler = app.slice(
    app.indexOf("document.addEventListener('contextmenu'"),
    app.indexOf('const runCardAction'),
  );
  assert.ok(handler.length > 0, 'the contextmenu handler moved');
  assert.ok(
    /if \(action === 'native'\) return;\s*\n\s*event\.preventDefault\(\);/.test(handler),
    'the native answer must return *before* preventDefault, and every other one after it',
  );
  assert.match(
    handler,
    /event\.preventDefault\(\);[\s\S]{0,220}if \(action === 'suppress'\) return;/,
    'suppress prevents the default and then opens nothing',
  );
  assert.ok(
    handler.includes('if (event.defaultPrevented) return;'),
    'a handler closer to the target — the drawer’s session rows — keeps its answer',
  );
  assert.ok(handler.includes('openCardMenu('), 'a card right-click opens the card menu');
  assert.ok(handler.includes('canvasMenu.open('), 'a background right-click opens the canvas menu');
  assert.ok(
    /notesLayer\.openMenu\(note, \{ clientX: event\.clientX, clientY: event\.clientY \}\)/.test(
      handler,
    ),
    'a note right-click opens the note menu at the event coordinates',
  );

  // The caret is read at the press, not at the menu: focusing a text field is
  // the default action of the very press that opens the menu, so asking later
  // would call every right-clicked note "being edited". A menu asked for from
  // the keyboard is preceded by no press and has to be answered from the caret
  // as it is now, so which happened is tracked rather than guessed at from
  // `event.button` — that is 2 on Windows and 0 for a Mac's Control-click.
  assert.match(
    app,
    /caretNoteAtPress = noteWithCaret\(\);\s*\n\s*askedByPointer = true;/,
    'the caret must be read while it is still where the user put it',
  );
  assert.match(
    app,
    /askedByPointer = false;/,
    'a keyboard-opened menu must not be answered with a stale press',
  );
  assert.ok(
    app.includes('const caret = askedByPointer ? caretNoteAtPress : noteWithCaret();'),
    'the two ways of asking for a menu read the caret from different moments',
  );

  // And the two canvas menus are the same element kind, so the stylesheet has
  // one rule; the note's menu is the note's own panel and always has been.
  const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
  assert.ok(html.includes('id="cardmenu" class="nz-menu"'));
  assert.ok(html.includes('id="canvasmenu" class="nz-menu"'));
});

test('the note menu a right-click opens is the one the ⋯ button opens', () => {
  const notes = readFileSync(path.join(webDir, 'notes.ts'), 'utf8');
  // One entry point for both gestures: the button calls `openMenu` too, so
  // there is no second menu to keep in step with this one.
  assert.match(
    notes,
    /menuButton\.addEventListener\('click', \(\) => \{\s*\n\s*if \(menu\.hidden\) this\.openMenu\(note\.id\);/,
    'the ⋯ button and the right-click must open the same menu the same way',
  );
  // Opened at a point, the panel is placed at that point in the note's own
  // coordinates — the layer is scaled, so screen pixels are divided back out.
  assert.ok(notes.includes('at.clientX - rect.left'), 'the pointer placement lost its origin');
  assert.ok(notes.includes('this.options.scale()'), 'the placement ignores the zoom');
  // Opened from the button, it goes back to where the stylesheet puts it.
  assert.match(notes, /style\.left = '';/, 'the button placement is not restored');

  // Keyboard: focus into the menu on open, Escape closes it and focus returns
  // to the ⋯ button — the same contract `CardMenu` and `CanvasMenu` keep.
  assert.ok(
    notes.includes("els.menu.querySelector<HTMLButtonElement>('button')?.focus()"),
    'an opened menu must take the keyboard',
  );
  assert.match(
    notes,
    /menu\.addEventListener\('keydown', \(event\) => \{[\s\S]{0,200}Escape[\s\S]{0,200}stopPropagation\(\)/,
    'Escape must close the note menu without closing anything behind it',
  );
  assert.ok(
    notes.includes('if (held) els.menuButton.focus();'),
    'closing the menu must put the keyboard back on the note',
  );

  // And the canvas closes a note menu on Escape from anywhere else.
  const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
  assert.match(
    app,
    /if \(notesLayer\.openMenuFor !== undefined\) \{\s*\n\s*notesLayer\.closeMenus\(\);/,
    'Escape outside the panel must close an open note menu first',
  );
});
