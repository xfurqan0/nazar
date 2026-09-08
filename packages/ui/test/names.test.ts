/**
 * WP4g: the name you give a card, and the three things it has to do — survive a
 * reload, disappear when it is cleared, and go when its session is gone for
 * good.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  cleanName,
  EMPTY_NAMES,
  MAX_NAME_LENGTH,
  NAMES_KEY,
  nameOf,
  pruneNames,
  readNames,
  withName,
  writeNames,
} from '../src/names.ts';
import { guarded, memoryStorage } from '../src/workspace.ts';

test('a fresh browser has no names at all', () => {
  assert.deepEqual(readNames(memoryStorage()), EMPTY_NAMES);
  assert.equal(nameOf(EMPTY_NAMES, 's1'), undefined);
});

test('a name round-trips through storage', () => {
  const storage = memoryStorage();
  writeNames(storage, withName(readNames(storage), 's1', '  the   importer  '));
  const back = readNames(storage);
  assert.equal(nameOf(back, 's1'), 'the importer', 'whitespace is squeezed');
  assert.equal(nameOf(back, 's2'), undefined);
});

test('committing an empty field clears the name', () => {
  const named = withName(EMPTY_NAMES, 's1', 'Backend');
  assert.equal(nameOf(named, 's1'), 'Backend');
  const cleared = withName(named, 's1', '   ');
  assert.equal(nameOf(cleared, 's1'), undefined);
  assert.deepEqual(cleared.names, {}, 'and the entry is gone, not blank');
});

test('a name is cut to something that fits a card', () => {
  assert.equal(cleanName('x'.repeat(200)).length, MAX_NAME_LENGTH);
  assert.equal(cleanName('a\n\tb'), 'a b', 'newlines and tabs are whitespace');
  assert.equal(cleanName('   '), '');
});

/**
 * The same rule tabs use: a session that ended keeps its name for as long as
 * Claude Code keeps its transcript, and loses it when that expires. The two
 * cannot disagree about which sessions exist, because they are pruned from the
 * same set in the same pass.
 */
test('pruneNames forgets sessions the machine no longer knows about', () => {
  let state = withName(EMPTY_NAMES, 'running-now', 'A');
  state = withName(state, 'ended-this-morning', 'B');
  state = withName(state, 'expired-last-month', 'C');

  const kept = pruneNames(state, new Set(['running-now', 'ended-this-morning']));
  assert.deepEqual(Object.keys(kept.names).sort(), ['ended-this-morning', 'running-now']);
});

test('a half-written or hand-edited store is not worth a broken canvas', () => {
  assert.deepEqual(readNames(memoryStorage({ [NAMES_KEY]: '{oops' })), EMPTY_NAMES);
  assert.deepEqual(readNames(memoryStorage({ [NAMES_KEY]: '[]' })), EMPTY_NAMES);
  assert.deepEqual(readNames(memoryStorage({ [NAMES_KEY]: '{"v":1}' })), EMPTY_NAMES);
  const mixed = readNames(
    memoryStorage({ [NAMES_KEY]: JSON.stringify({ v: 1, names: { a: 'A', b: 7, c: '  ' } }) }),
  );
  assert.deepEqual(mixed.names, { a: 'A' }, 'only strings, and only non-empty ones');
});

test('a blocked storage loses the name and nothing else', () => {
  const storage = guarded({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  writeNames(storage, withName(EMPTY_NAMES, 's1', 'Backend'));
  // The write went to the in-memory fallback, so it reads back within the
  // session and simply does not survive a reload.
  assert.equal(nameOf(readNames(storage), 's1'), 'Backend');
});
