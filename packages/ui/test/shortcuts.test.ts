/**
 * The keyboard map.
 *
 * A shortcut table grows wrong branches quietly: <kbd>Ctrl</kbd>+<kbd>1</kbd>
 * firing the plain <kbd>1</kbd> action, a bare letter stealing a browser chord,
 * a canvas key firing while someone is naming a tab. All three are one
 * assertion each here and none of them is visible in an event handler.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import { shortcutFor, shortcutLabel } from '../src/shortcuts.ts';

test('Ctrl and Cmd plus a digit switch tabs, counting from zero', () => {
  assert.deepEqual(shortcutFor({ key: '1', ctrlKey: true }), { kind: 'tab', index: 0 });
  assert.deepEqual(shortcutFor({ key: '9', metaKey: true }), { kind: 'tab', index: 8 });
  assert.deepEqual(shortcutFor({ key: '5', ctrlKey: true }), { kind: 'tab', index: 4 });
});

test('a bare digit is not a tab switch', () => {
  assert.equal(shortcutFor({ key: '1' }), undefined);
  assert.deepEqual(shortcutFor({ key: '0' }), { kind: 'fit' }, 'except zero, which fits');
  assert.equal(shortcutFor({ key: '0', ctrlKey: true }), undefined, 'and Ctrl+0 is the browser’s');
});

test('the bare letters are the canvas actions', () => {
  assert.deepEqual(shortcutFor({ key: 'a' }), { kind: 'arrange' });
  assert.deepEqual(shortcutFor({ key: 'A' }), { kind: 'arrange' });
  assert.deepEqual(shortcutFor({ key: 'h' }), { kind: 'history' });
  assert.deepEqual(shortcutFor({ key: 'm' }), { kind: 'sidebar' });
  assert.deepEqual(shortcutFor({ key: 'Escape' }), { kind: 'close' });
  assert.deepEqual(shortcutFor({ key: '+' }), { kind: 'zoom-in' });
  assert.deepEqual(shortcutFor({ key: '=' }), { kind: 'zoom-in' });
  assert.deepEqual(shortcutFor({ key: '-' }), { kind: 'zoom-out' });
});

test('a modifier that is not Ctrl or Cmd hands the key back', () => {
  assert.equal(shortcutFor({ key: 'a', ctrlKey: true }), undefined);
  assert.equal(shortcutFor({ key: 'a', altKey: true }), undefined);
  assert.equal(shortcutFor({ key: '1', ctrlKey: true, altKey: true }), undefined);
  assert.equal(shortcutFor({ key: 'F5' }), undefined);
  assert.equal(shortcutFor({ key: 'Tab' }), undefined);
});

test('shortcutLabel names the chord the way the platform writes it', () => {
  assert.equal(shortcutLabel({ kind: 'tab', index: 0 }), 'Ctrl+1');
  assert.equal(shortcutLabel({ kind: 'tab', index: 2 }, true), '⌘+3');
  assert.equal(shortcutLabel({ kind: 'arrange' }), 'a');
  assert.equal(shortcutLabel({ kind: 'close' }), 'Esc');
});
