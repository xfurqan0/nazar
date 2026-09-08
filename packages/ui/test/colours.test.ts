/**
 * WP4e: the user's own frame colours.
 *
 * The rules worth pinning are the ones a careless change would quietly break:
 * a reset must **remove** a custom property rather than write the theme's
 * current value into it, storage must survive a round trip and must refuse
 * anything that is not one of the five, and the contrast hint must be a hint —
 * a number and a verdict, never a refusal.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  COLOURS_KEY,
  COLOUR_KEYS,
  COLOUR_LABEL_KEYS,
  colourLabel,
  cleanColour,
  colourApplication,
  colourVariable,
  contrastHint,
  isColour,
  NON_TEXT_MINIMUM,
  overriddenCount,
  readColours,
  withColour,
  withoutColour,
  writeColours,
  type ColourOverrides,
} from '../src/colours.ts';
import { STATE_KEYS } from '../src/theme.ts';
import { memoryStorage } from '../src/workspace.ts';

test('the five overridable colours are the five activity tokens', () => {
  assert.deepEqual([...COLOUR_KEYS], [...STATE_KEYS]);
  for (const key of COLOUR_KEYS) {
    assert.ok(colourLabel(key).length > 0, `${key} has no word on the card`);
  }
  // The label is the word the card shows, not the token name: `stateAlive` is
  // drawn as `idle`, and a settings panel that said `stateAlive` would be
  // asking the user to learn the codebase.
  // N-WP13: the words come out of the catalogue now, and out of the same
  // `state.*` entries the cards use, so the picker and the card cannot end up
  // with two vocabularies for one thing.
  assert.equal(colourLabel('stateAlive'), 'idle');
  assert.equal(colourLabel('stateWorking'), 'working');
  assert.equal(COLOUR_LABEL_KEYS.stateAlive, 'state.idle');
});

test('a token becomes the custom property the stylesheet already reads', () => {
  assert.equal(colourVariable('stateWorking'), '--nz-state-working');
  assert.equal(colourVariable('stateUnknown'), '--nz-state-unknown');
});

test('only six- and eight-digit hex is a colour', () => {
  assert.ok(isColour('#3FE3A6'));
  assert.ok(isColour('#3fe3a6ff'));
  assert.equal(isColour('#abc'), false);
  assert.equal(isColour('rebeccapurple'), false);
  assert.equal(isColour('rgb(1,2,3)'), false);
  assert.equal(isColour(42), false);
});

test('a colour is stored in one shape, whatever the picker hands over', () => {
  // Browsers report `#rrggbb` in lower case and the theme files are upper, so
  // one shape is what lets "is this still the theme's colour" be a string
  // comparison rather than a second source of truth.
  assert.equal(cleanColour('#3fe3a6'), '#3FE3A6');
  assert.equal(cleanColour('  #3FE3A6 '), '#3FE3A6');
  assert.equal(cleanColour('nonsense'), undefined);
  assert.equal(cleanColour(undefined), undefined);
});

test('overrides round-trip through storage', () => {
  const storage = memoryStorage();
  const colours = withColour(withColour({}, 'stateWorking', '#ff0000'), 'stateDone', '#00FF00');
  writeColours(storage, colours);

  const back = readColours(storage);
  assert.deepEqual(back, { stateWorking: '#FF0000', stateDone: '#00FF00' });
  assert.equal(overriddenCount(back), 2);

  // And the stored document says which version wrote it, like every other one.
  const raw = JSON.parse(storage.getItem(COLOURS_KEY) ?? '{}') as Record<string, unknown>;
  assert.equal(raw['v'], 1);
});

test('storage that was hand-edited is read for the parts that are colours', () => {
  const storage = memoryStorage({
    [COLOURS_KEY]: JSON.stringify({
      v: 1,
      stateWorking: '#123456',
      stateDone: 'not a colour',
      somethingElse: '#FFFFFF',
    }),
  });
  assert.deepEqual(readColours(storage), { stateWorking: '#123456' });

  assert.deepEqual(readColours(memoryStorage({ [COLOURS_KEY]: 'not json' })), {});
  assert.deepEqual(readColours(memoryStorage({ [COLOURS_KEY]: '[1,2,3]' })), {});
  assert.deepEqual(readColours(memoryStorage()), {});
});

test('setting an invalid colour clears the override rather than storing it', () => {
  const set = withColour({}, 'stateWaiting', '#AABBCC');
  assert.equal(set.stateWaiting, '#AABBCC');
  assert.equal(withColour(set, 'stateWaiting', 'blue').stateWaiting, undefined);
  assert.equal(withoutColour(set, 'stateWaiting').stateWaiting, undefined);
});

test('a reset removes the property; it never freezes the theme colour into it', () => {
  const colours: ColourOverrides = { stateWorking: '#FF0000' };
  const { set, clear } = colourApplication(colours);

  assert.deepEqual(set, [['--nz-state-working', '#FF0000']]);
  // The other four are cleared, not written: leaving a value behind would nail
  // that colour down and the next theme change would find it there.
  assert.equal(clear.length, COLOUR_KEYS.length - 1);
  assert.ok(clear.includes('--nz-state-alive'));
  assert.equal(clear.includes('--nz-state-working'), false);

  const empty = colourApplication({});
  assert.deepEqual(empty.set, []);
  assert.equal(empty.clear.length, COLOUR_KEYS.length);
});

test('the hint measures against the card and advises rather than refuses', () => {
  // Black on white is the ratio everybody knows.
  const strong = contrastHint('#000000', '#FFFFFF');
  assert.ok(strong !== undefined);
  assert.equal(strong.text, '21.0:1');
  assert.ok(strong.passes);

  // A pale yellow frame on a white card is legal, and is told it is faint.
  const weak = contrastHint('#FFF6C0', '#FFFFFF');
  assert.ok(weak !== undefined);
  assert.ok(weak.ratio < NON_TEXT_MINIMUM);
  assert.equal(weak.passes, false);
  assert.match(weak.description, /below the 3:1 minimum/);
  // And it is still a hint: nothing here returns an error or refuses a value.
  assert.equal(typeof weak.text, 'string');

  // A ground that cannot be parsed produces no hint at all, rather than a
  // number measured against a guess.
  assert.equal(contrastHint('#000000', 'var(--nz-node)'), undefined);
  assert.equal(contrastHint('nonsense', '#FFFFFF'), undefined);
});
